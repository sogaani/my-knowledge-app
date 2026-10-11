# Deploy: Argo CD + Helm + Cloudflare Tunnel Ingress + Zero Trust operator

```
Browser ─Cloudflare Access (Google)─▶ Tunnel ─▶ cloudflare-tunnel-ingress-controller ─▶ kb-api Service ─▶ kb-api Pod
                                                                      PVC /data: kb (git clone, git-crypt unlocked), app/jobs.sqlite, app/staging
Mac worker ─Access service token + WORKER_TOKEN─▶ https://kb.wanawata.com/api/worker/*
```

| Path | |
|---|---|
| `deploy/Dockerfile`, `entrypoint.sh` | Image (built to GHCR by `.github/workflows/image.yml`) |
| `deploy/helm/kb-api/` | Helm chart: Deployment, Service, Ingress, ConfigMap, PVC, Cloudflare Access app + service token (cloudflare-zero-trust-operator CRs) |
| `deploy/argocd/application.yaml` | Argo CD Application that syncs the chart from `main` |

Rollout: push to `main` → CI builds `ghcr.io/sogaani/my-knowledge-app:<sha>` → CI commits that sha into `deploy/helm/kb-api/values.yaml` → Argo CD syncs.

## 1. Secrets (out of band, never committed)
```
kubectl create namespace my-knowledge
```
- **Deploy key** (read/write) for the data repo: `ssh-keygen -t ed25519 -f deploy_key -N ""`, add the public key to the repo (GitHub: Settings → Deploy keys, allow write).
  `kubectl -n my-knowledge create secret generic kb-git --from-file=deploy_key`
- **git-crypt key**: on the Mac, in the data repo, `git-crypt export-key ./git-crypt.key` (store the same file in 1Password).
  `kubectl -n my-knowledge create secret generic kb-git-crypt --from-file=key=git-crypt.key`
- **API secret**: `kubectl -n my-knowledge create secret generic kb-api --from-literal=WORKER_TOKEN=$(openssl rand -hex 32) --from-literal=CF_ACCESS_AUD=pending` (set the real AUD after the first sync, see §2)
- **GHCR pull secret** (only if the package is private): `kubectl -n my-knowledge create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=sogaani --docker-password=<PAT with read:packages>`, then set `imagePullSecrets: [{ name: ghcr }]` in values.

## 2. Cloudflare Access
The cluster's [cloudflare-zero-trust-operator](https://github.com/BojanZelic/cloudflare-zero-trust-operator) creates everything from `templates/access.yaml`:
- `CloudflareAccessApplication` `my-knowledge` on `kb.wanawata.com` with two policies:
  - `worker` (Service Auth / `non_identity`): the `kb-worker` service token, no login.
  - `owner` (allow): `access.allowedEmails` (only `soga.ani@gmail.com`). The same list becomes the API's `ALLOWED_EMAILS`.
- `CloudflareServiceToken` `kb-worker` → Secret `kb-worker` (`cloudflareClientId`, `cloudflareSecretKey`). The pod reads the Client ID from it as `WORKER_SERVICE_TOKEN_NAME`.

Both carry `cloudflare.zelic.io/prevent-destroy: "true"`, so deleting the Argo app leaves them in Cloudflare.

One-time, in the Cloudflare Zero Trust dashboard (https://one.dash.cloudflare.com/, team `sogaani`):
1. **Integrations → Identity providers → Add new → Google.** It asks for an OAuth client from Google Cloud Console (https://console.cloud.google.com):
   - APIs & Services → OAuth consent screen: External; add `soga.ani@gmail.com` as a test user.
   - Credentials → Create credentials → OAuth client ID → Web application:
     - Authorized JavaScript origins: `https://sogaani.cloudflareaccess.com`
     - Authorized redirect URIs: `https://sogaani.cloudflareaccess.com/cdn-cgi/access/callback`
   - Paste the Client ID / Client Secret into Cloudflare, save, then **Test**.

   Alternative without Google: the built-in **One-time PIN** provider (a code mailed to the address). The `owner` policy matches by email, so it works with either.
2. Team domain `sogaani.cloudflareaccess.com` is already set in `config.CF_ACCESS_TEAM_DOMAIN` (shown under Settings → Team name and domain).

After the first sync (the operator doesn't expose the AUD):
```
# Access → Applications → my-knowledge → Overview → Application Audience (AUD) Tag
kubectl -n my-knowledge patch secret kb-api --type merge -p '{"stringData":{"CF_ACCESS_AUD":"<aud>"}}'
kubectl -n my-knowledge rollout restart deploy/kb-api
```

### How the worker authenticates
1. The Mac worker sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` (the `kb-worker` token) and `Authorization: Bearer $WORKER_TOKEN`.
2. Cloudflare Access matches the `worker` policy and forwards the request with a signed `Cf-Access-Jwt-Assertion` whose `common_name` is the token's Client ID.
3. The API (`apps/api/src/auth.ts`) verifies the JWT against the team's JWKS (issuer + `CF_ACCESS_AUD`), checks `common_name` == `WORKER_SERVICE_TOKEN_NAME`, then requires the matching `WORKER_TOKEN`. Worker routes reject users with 403.

## 3. Argo CD
1. Edit `deploy/helm/kb-api/values.yaml` if needed (`persistence.storageClass`). Commit and push.
2. If this repo is private, add it to Argo CD (Settings → Repositories, or `argocd repo add https://github.com/sogaani/my-knowledge-app.git --username sogaani --password <PAT>`).
3. Register the app once:
   ```
   kubectl apply -n tomorrow -f deploy/argocd/application.yaml
   argocd app get kb-api
   kubectl -n my-knowledge logs deploy/kb-api -f
   ```
Auto-sync with prune + selfHeal is on: change the cluster through git, not `kubectl edit`.
Render locally: `helm template kb-api deploy/helm/kb-api -n my-knowledge`.

### Migrating from the old `deploy/k8s` kustomize setup
- Delete the hand-made Access application and `kb-worker` service token in the dashboard; the operator creates its own (new Client ID/Secret → update the Mac `.env`).
- The Deployment selector changed (`app: kb-api` → `app.kubernetes.io/*`) and selectors are immutable: `kubectl -n my-knowledge delete deploy/kb-api` before the first sync.
- Remove the private connector: `kubectl -n my-knowledge delete deploy/cloudflared secret/cloudflared`, and delete the old public hostname from that tunnel in the Cloudflare dashboard (the ingress controller recreates it on its own tunnel).
- The `kb-data` PVC keeps its name, so Argo adopts it with the cloned repo and sqlite intact.

## 4. Mac worker
```
cp apps/worker/.env.example apps/worker/.env   # KB_API_URL, WORKER_TOKEN, CF_ACCESS_CLIENT_ID/SECRET, KB_ROOT, KB_AGENT
kubectl -n my-knowledge get secret kb-worker -o jsonpath='{.data.cloudflareClientId}' | base64 -d    # → CF_ACCESS_CLIENT_ID
kubectl -n my-knowledge get secret kb-worker -o jsonpath='{.data.cloudflareSecretKey}' | base64 -d   # → CF_ACCESS_CLIENT_SECRET
kubectl -n my-knowledge get secret kb-api -o jsonpath='{.data.WORKER_TOKEN}' | base64 -d             # → WORKER_TOKEN
bun run worker            # or install the launchd agent: deploy/launchd/install.sh
```

## Notes
- Data updates never redeploy the Pod: the worker reports a commit, the API `git pull`s and re-indexes. A 5-minute `git fetch` catches manual pushes.
- On the first sync the pod sits in `CreateContainerConfigError` until the operator has written Secret `kb-worker`; it starts on its own once it exists.
- `strategy: Recreate` — the SQLite files on the PVC must not be opened by two Pods.
- The PVC is annotated `helm.sh/resource-policy: keep` and `argocd.argoproj.io/sync-options: Delete=false`: deleting the Argo app leaves the data.
- ConfigMap changes restart the Pod (`checksum/config`). Secret changes don't: `kubectl -n my-knowledge rollout restart deploy/kb-api` after rotating the git-crypt key or deploy key.
- Roll back by reverting the tag-bump commit (or `argocd app rollback kb-api`, which pauses auto-sync).

## Semantic search

Vectors (Ollama bge-m3) and the Lindera BM25 index live on the Mac in `90_system/cache/lance/`. The pod keeps `KB_EMBED=off` and serves `GET /api/search` by handing a `search` job to the worker, falling back to the SQLite keyword search after `SEARCH_TIMEOUT_MS`. See `docs/search.md`.
