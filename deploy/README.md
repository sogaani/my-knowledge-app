# Deploy: Argo CD + Helm + Cloudflare Tunnel Ingress + Zero Trust operator

```
Browser ─Cloudflare Access (Google)─▶ Tunnel ─▶ cloudflare-tunnel-ingress-controller ─▶ kb-api Service ─▶ kb-api Pod
                                                                      /data     kb-data  (NFS)        kb: git clone, git-crypt unlocked
                                                                      /data/app kb-state (local-path) jobs.sqlite, staging
                                                                      /cache    emptyDir             kb.sqlite (note index, rebuilt on start)
Mac worker ─Access service token + WORKER_TOKEN─▶ https://kb.wanawata.com/api/worker/*  (+ POST /api/jobs for launchd schedules)
Gmail GAS  ─Access service token kb-ingest + INGEST_TOKEN─▶ https://kb.wanawata.com/api/inbox  (push only)
```

| Path | |
|---|---|
| `deploy/Dockerfile`, `entrypoint.sh` | Image (built to GHCR by `.github/workflows/image.yml`) |
| `deploy/helm/kb-api/` | Helm chart: Deployment, Service, Ingress, ConfigMap, PVCs, Cloudflare Access app + service token (cloudflare-zero-trust-operator CRs) |
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
- **API secret**: `kubectl -n my-knowledge create secret generic kb-api --from-literal=WORKER_TOKEN=$(openssl rand -hex 32) --from-literal=INGEST_TOKEN=$(openssl rand -hex 32) --from-literal=CF_ACCESS_AUD=pending` (set the real AUD after the first sync, see §2)
  - Existing cluster: `kubectl -n my-knowledge patch secret kb-api --type merge -p '{"stringData":{"INGEST_TOKEN":"'"$(openssl rand -hex 32)"'"}}' && kubectl -n my-knowledge rollout restart deploy/kb-api`
- **GHCR pull secret** (only if the package is private): `kubectl -n my-knowledge create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=sogaani --docker-password=<PAT with read:packages>`, then set `imagePullSecrets: [{ name: ghcr }]` in values.

## 2. Cloudflare Access
The cluster's [cloudflare-zero-trust-operator](https://github.com/BojanZelic/cloudflare-zero-trust-operator) creates everything from `templates/access.yaml`:
- `CloudflareAccessApplication` `my-knowledge` on `kb.wanawata.com` with three policies (created in this order; a failure stops at that policy, so `owner` is always protected first):
  - `owner` (allow): `access.allowedEmails` (only `soga.ani@gmail.com`). The same list becomes the API's `ALLOWED_EMAILS`.
  - `worker` (Service Auth / `non_identity`): the `kb-worker` service token, no login.
  - `ingest` (Service Auth / `non_identity`): the `kb-ingest` service token used by the Gmail Apps Script.
- `CloudflareServiceToken` `kb-worker` → Secret `kb-worker` (`cloudflareClientId`, `cloudflareSecretKey`). The pod reads the Client ID from it as `WORKER_SERVICE_TOKEN_NAME`.
- `CloudflareServiceToken` `kb-ingest` → Secret `kb-ingest` (same keys). The pod reads the Client ID as `INGEST_SERVICE_TOKEN_NAME` (optional, so the rollout never waits on it).

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
3. The API (`apps/api/src/auth.ts`) verifies the JWT against the team's JWKS (issuer + `CF_ACCESS_AUD`), checks `common_name` == `WORKER_SERVICE_TOKEN_NAME`, then requires the matching `WORKER_TOKEN`. Worker routes reject users with 403. The worker may also `POST /api/jobs` (that is how the launchd schedules in the data repo enqueue `ingest` / `skill` runs via `90_system/scripts/enqueue.sh`).

### How the Gmail pusher (Apps Script) authenticates
Same three steps with the `kb-ingest` token and `Authorization: Bearer $INGEST_TOKEN`; the JWT's `common_name` must equal `INGEST_SERVICE_TOKEN_NAME`. The resulting principal is `service`, which is accepted **only** by `POST /api/inbox` (every other route answers 403), so a leaked script property cannot read notes, claim jobs or trigger syncs. Paste these into the Apps Script project (Project Settings → Script Properties), see `my-knowledge/90_system/gas/emailfilter/README.md`:
```
kubectl -n my-knowledge get secret kb-ingest -o jsonpath='{.data.cloudflareClientId}' | base64 -d    # → CF_ACCESS_CLIENT_ID
kubectl -n my-knowledge get secret kb-ingest -o jsonpath='{.data.cloudflareSecretKey}' | base64 -d   # → CF_ACCESS_CLIENT_SECRET
kubectl -n my-knowledge get secret kb-api -o jsonpath='{.data.INGEST_TOKEN}' | base64 -d             # → INGEST_TOKEN
```
Smoke test from a shell: `curl -s https://kb.wanawata.com/api/me -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" -H "Authorization: Bearer $INGEST_TOKEN"` → `{"principal":{"kind":"service",…}}`; the same headers on `GET /api/jobs` → 403. `POST /api/inbox` with files already staged under the same name answers 200 with `job: null` and `skipped: [...]`, so the pusher can label them as done.

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
- The `kb-data` PVC keeps its name, so Argo adopts it with the cloned repo intact. Old SQLite files on it (`app/jobs.sqlite*`, `kb/90_system/cache/kb.sqlite*`) are no longer used and can be deleted.

## 4. Mac worker
```
cp apps/worker/.env.example apps/worker/.env   # KB_API_URL, WORKER_TOKEN, CF_ACCESS_CLIENT_ID/SECRET, KB_ROOT, KB_AGENT
kubectl -n my-knowledge get secret kb-worker -o jsonpath='{.data.cloudflareClientId}' | base64 -d    # → CF_ACCESS_CLIENT_ID
kubectl -n my-knowledge get secret kb-worker -o jsonpath='{.data.cloudflareSecretKey}' | base64 -d   # → CF_ACCESS_CLIENT_SECRET
kubectl -n my-knowledge get secret kb-api -o jsonpath='{.data.WORKER_TOKEN}' | base64 -d             # → WORKER_TOKEN
bun run worker            # try it in the foreground first
```
Keep it running with launchd. **The launchd registration lives in the data repo, not here**: `my-knowledge/90_system/launchd/com.my-knowledge.worker.plist` (label `com.my-knowledge.worker`) is installed together with the schedule agents (daily ingest, weekly recommend/moneytree, monthly review/audit/maintain) by `my-knowledge/90_system/scripts/launchd.sh`. This repo only provides the worker code and its `.env`.
```
~/git/my-knowledge/90_system/scripts/launchd.sh                 # install / reinstall everything (also removes the legacy local.kb-worker agent)
tail -f ~/git/my-knowledge/90_system/logs/worker.log
launchctl kickstart -k gui/$(id -u)/com.my-knowledge.worker       # restart after editing .env or pulling new worker code
~/git/my-knowledge/90_system/scripts/launchd.sh uninstall
```
The plist runs the worker through `bash -l`, so the agent CLI (claude/codex/gemini), bun, git and git-crypt must be on the login shell's PATH.

## Notes
- Data updates never redeploy the Pod: the worker reports a commit, the API `git pull`s and re-indexes. A 5-minute `git fetch` catches manual pushes.
- On the first sync the pod sits in `CreateContainerConfigError` until the operator has written Secret `kb-worker`; it starts on its own once it exists.
- SQLite never lives on NFS: the `nfs-client` mount (NFSv3, server-side locking) can't take SQLite's file locks, so it fails with `SQLITE_BUSY` in any journal mode. `jobs.sqlite` is on the `local-path` PVC `kb-state`; the index `kb.sqlite` is in an emptyDir (`KB_DB=/cache/kb.sqlite`).
- `kb-state` is node-local: the Pod is pinned to the node that holds it. If that node is gone, the job/chat history is lost (notes are safe in git); delete the PVC and the Pod starts fresh elsewhere.
- `strategy: Recreate` — the SQLite files must not be opened by two Pods.
- The PVCs are annotated `helm.sh/resource-policy: keep` and `argocd.argoproj.io/sync-options: Delete=false`: deleting the Argo app leaves the data.
- ConfigMap changes restart the Pod (`checksum/config`). Secret changes don't: `kubectl -n my-knowledge rollout restart deploy/kb-api` after rotating the git-crypt key or deploy key.
- Roll back by reverting the tag-bump commit (or `argocd app rollback kb-api`, which pauses auto-sync).

## Semantic search

Vectors (Ollama bge-m3) and the Lindera BM25 index live on the Mac in `90_system/cache/lance/`. The pod keeps `KB_EMBED=off` and serves `GET /api/search` by handing a `search` job to the worker, falling back to the SQLite keyword search after `SEARCH_TIMEOUT_MS`. See `docs/search.md`.
