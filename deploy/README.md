# Deploy: Argo CD + Helm + Cloudflare Tunnel Ingress + Zero Trust operator

```
Browser ─Cloudflare Access (Google)─▶ Tunnel ─▶ cloudflare-tunnel-ingress-controller ─▶ kb-api Service ─▶ kb-api Pod
                                                                      /data     kb-data  (NFS)        kb: git clone, git-crypt unlocked
                                                                      /data/app kb-state (local-path) jobs.sqlite, staging
                                                                      /cache    emptyDir             kb.sqlite (note index, rebuilt on start)
Mac worker ─Access service token + WORKER_TOKEN─▶ https://kb.wanawata.com/api/worker/*  (+ POST /api/jobs for launchd schedules)
```
Gmail is pulled by the Mac collector (`docs/collect.md`); the old Apps Script push path (`kb-ingest` service token, `INGEST_TOKEN`, a `service` principal on `POST /api/inbox`) was removed in 2026-10, see §5.

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
- **API secret**: `kubectl -n my-knowledge create secret generic kb-api --from-literal=WORKER_TOKEN=$(openssl rand -hex 32) --from-literal=CF_ACCESS_AUD=pending` (set the real AUD after the first sync, see §2)
- **Web Push (VAPID)**, optional — without it the 売買 tab hides the notification button:
  `cd apps/api && bunx web-push generate-vapid-keys` then
  `kubectl -n my-knowledge patch secret kb-api --type merge -p '{"stringData":{"VAPID_PUBLIC_KEY":"<public>","VAPID_PRIVATE_KEY":"<private>","VAPID_SUBJECT":"mailto:soga.ani@gmail.com"}}' && kubectl -n my-knowledge rollout restart deploy/kb-api`.
  Subscriptions live in `jobs.sqlite` (`push_subscriptions`); rotating the keys invalidates them (re-enable from the tab). Phones: Android Chrome works from the site; iOS needs the site added to the Home Screen (standalone app has its own cookies, so Access asks to log in again there).
- **GHCR pull secret** (only if the package is private): `kubectl -n my-knowledge create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=sogaani --docker-password=<PAT with read:packages>`, then set `imagePullSecrets: [{ name: ghcr }]` in values.

## 2. Cloudflare Access
The cluster's [cloudflare-zero-trust-operator](https://github.com/BojanZelic/cloudflare-zero-trust-operator) creates everything from `templates/access.yaml`:
- `CloudflareAccessApplication` `my-knowledge` on `kb.wanawata.com` with two policies (created in this order; a failure stops at that policy, so `owner` is always protected first):
  - `owner` (allow): `access.allowedEmails` (only `soga.ani@gmail.com`). The same list becomes the API's `ALLOWED_EMAILS`.
  - `worker` (Service Auth / `non_identity`): the `kb-worker` service token, no login.
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
3. The API (`apps/api/src/auth.ts`) verifies the JWT against the team's JWKS (issuer + `CF_ACCESS_AUD`), checks `common_name` == `WORKER_SERVICE_TOKEN_NAME`, then requires the matching `WORKER_TOKEN`. Worker routes reject users with 403. The worker may also `POST /api/jobs` (that is how the launchd schedules in the data repo enqueue `ingest` / `skill` runs via `900_system/scripts/enqueue.sh`).

`POST /api/inbox` is the owner's (web UI) only; the API knows no other principal than `user` and `worker`.

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
- The `kb-data` PVC keeps its name, so Argo adopts it with the cloned repo intact. Old SQLite files on it (`app/jobs.sqlite*`, `kb/900_system/cache/kb.sqlite*`) are no longer used and can be deleted.

## 4. Mac worker
```
cp apps/worker/.env.example apps/worker/.env   # KB_API_URL, WORKER_TOKEN, CF_ACCESS_CLIENT_ID/SECRET, KB_ROOT, KB_AGENT
kubectl -n my-knowledge get secret kb-worker -o jsonpath='{.data.cloudflareClientId}' | base64 -d    # → CF_ACCESS_CLIENT_ID
kubectl -n my-knowledge get secret kb-worker -o jsonpath='{.data.cloudflareSecretKey}' | base64 -d   # → CF_ACCESS_CLIENT_SECRET
kubectl -n my-knowledge get secret kb-api -o jsonpath='{.data.WORKER_TOKEN}' | base64 -d             # → WORKER_TOKEN
bun run worker            # try it in the foreground first
```
Keep it running with launchd. **The launchd registration lives in the data repo, not here**: `my-knowledge/900_system/launchd/com.my-knowledge.worker.plist` (label `com.my-knowledge.worker`) is installed together with the schedule agents (daily ingest, weekly recommend/moneytree, monthly review/audit/maintain) by `my-knowledge/900_system/scripts/launchd.sh`. This repo only provides the worker code and its `.env`.
```
~/git/my-knowledge/900_system/scripts/launchd.sh                 # install / reinstall everything (also removes the legacy local.kb-worker agent)
tail -f ~/git/my-knowledge/900_system/logs/worker.log
launchctl kickstart -k gui/$(id -u)/com.my-knowledge.worker       # restart after editing .env or pulling new worker code
~/git/my-knowledge/900_system/scripts/launchd.sh uninstall
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

## 5. Secrets: where they live and how to rotate them

Nothing here is committed. Each secret lives in exactly one runtime place plus 1Password; rotate by generating a new one, writing it there, and restarting what reads it. The Mac `.env` files are `chmod 600` (`bun run collect` and `launchd.sh` enforce it).

| Secret | Lives in | Expires | Rotate |
|---|---|---|---|
| GitHub fine-grained PAT (`GITHUB_TOKEN`) | `apps/collector/.env` | the date chosen at creation (`GITHUB_TOKEN_EXPIRES`); the collector warns 7 days ahead and in the morning digest | GitHub → Settings → Developer settings → Fine-grained tokens → Regenerate; write `GITHUB_TOKEN` and `GITHUB_TOKEN_EXPIRES` in the `.env`; `bun run collect status` |
| Google refresh tokens (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_HEALTH_REFRESH_TOKEN`) | `apps/collector/.env` | 7 days after consent while the consent screen is in Testing (`docs/collect.md`); warned 1.5 days ahead | `bun run collect auth` (both) or `auth google` / `auth google-health`; the issue dates are written for you |
| Google OAuth client (`GOOGLE_CLIENT_ID/SECRET`) | `apps/collector/.env` | — | Cloud Console → Credentials → reset secret; then `bun run collect auth` (both tokens are bound to the client) |
| `WORKER_TOKEN` | Secret `kb-api` and `apps/worker/.env` | — | `kubectl -n my-knowledge patch secret kb-api --type merge -p '{"stringData":{"WORKER_TOKEN":"'"$(openssl rand -hex 32)"'"}}'`, `rollout restart deploy/kb-api`, write the same value in the worker `.env`, `launchctl kickstart -k gui/$(id -u)/com.my-knowledge.worker` |
| Access service token `kb-worker` (`CF_ACCESS_CLIENT_ID/SECRET`) | Cloudflare (operator CR) → Secret `kb-worker`; copy in `apps/worker/.env` | Cloudflare default 1 year (dashboard → Access → Service Auth shows the date) | Dashboard: Service Auth → `kb-worker` → Refresh (keeps the Client ID, so the pod needs no change); copy the new Client Secret into the worker `.env` and kickstart the worker. If the Client ID changed instead (token recreated), `rollout restart deploy/kb-api` as well |
| VAPID key pair | Secret `kb-api` | — | `bunx web-push generate-vapid-keys`, patch the Secret (§1), rollout restart; every browser must re-enable notifications |
| git-crypt key | Secret `kb-git-crypt`, 1Password, each Mac clone | — | git-crypt cannot rekey history: only if leaked — re-encrypt the data repo with a new key (`git-crypt` has no built-in rotation; rewrite history or accept exposure of past commits), replace the Secret, restart the pod, re-unlock the Mac clone |
| Deploy key (`kb-git`) | Secret `kb-git`, GitHub → data repo → Deploy keys | — | `ssh-keygen -t ed25519`, add the new public key (write access) to the repo, replace the Secret, rollout restart, delete the old key on GitHub |
| `CF_ACCESS_AUD` | Secret `kb-api` | changes only when the Access application is recreated | copy from the dashboard (§2) |

Leftovers of the removed Gmail push path (one-time, by hand; the chart no longer creates them):
```
kubectl -n my-knowledge patch secret kb-api --type json -p '[{"op":"remove","path":"/data/INGEST_TOKEN"}]' && kubectl -n my-knowledge rollout restart deploy/kb-api
kubectl -n my-knowledge delete secret kb-ingest   # written by the operator for the CR Argo now prunes; prevent-destroy leaves the Cloudflare side
```
then in the Zero Trust dashboard delete the `kb-ingest` service token (Access → Service Auth) and, if an `ingest` policy still shows on the application, remove it there. The Apps Script Script Properties `KB_API_URL` / `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` / `INGEST_TOKEN` are unused and can be deleted (`my-knowledge/900_system/gas/emailfilter/README.md`).

## Semantic search

Vectors (Ollama bge-m3) and the Lindera BM25 index live on the Mac in `900_system/cache/lance/`. The pod keeps `KB_EMBED=off` and serves `GET /api/search` by handing a `search` job to the worker, falling back to the SQLite keyword search after `SEARCH_TIMEOUT_MS`. See `docs/search.md`.
