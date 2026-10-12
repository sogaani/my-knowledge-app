# my-knowledge-app — AI エージェント共通ルール

個人ナレッジベース（データ: `my-knowledge` リポジトリ）を扱うアプリ一式。Bun workspace + TypeScript。
このファイルが唯一のルール正本。Claude Code は `CLAUDE.md`（`@AGENTS.md`）、Gemini CLI は `.gemini/settings.json` の `contextFileName` 経由で読む。Codex はそのまま読む。
ナレッジベースのデータ構造・ノートの書き方のルールはデータ側の `my-knowledge/AGENTS.md` が正本。ここには書かない。

## 1. 構成

| パス | 役割 | 動く場所 |
|---|---|---|
| `packages/core` (`@kb/core`) | ノート・frontmatter・SQLite 索引・LanceDB 検索・Gold 生成などの処理ロジック全部 | 共通 |
| `apps/cli` (`@kb/cli`) | `kb` コマンド。core を呼ぶだけの薄い層 | Mac |
| `apps/worker` | API のジョブ（ingest / ask / recommend / search）を long-poll してエージェント CLI や core で処理 | Mac |
| `apps/collector` | Bronze collector。GitHub・Gmail・Google カレンダー・YouTube・Google Health・LinkedIn エクスポート ZIP を取得して `000_inbox` に JSON で置く（`bun run collect`、launchd で毎朝）。秘密は `apps/collector/.env`。ロジックは `packages/core/src/collect` | Mac |
| `apps/api` | Hono の HTTP API。Cloudflare Access（JWT）で認証。principal は `user`（WebUI）/ `worker`（Mac、`/api/worker/*` と `POST /api/jobs`）/ `service`（Gmail の Apps Script、`POST /api/inbox` のみ）。ジョブキューは SQLite | k8s |
| `apps/web` | React + Vite の WebUI。`public/sw.js` は Web Push 専用の Service Worker（オフラインキャッシュなし）。通知は API の `/api/push/*` と worker のジョブ完了（`notifyJobDone`）から送る | k8s（API が配信） |
| `deploy/` | Dockerfile・Helm chart（`helm/kb-api`）・Argo CD Application・手順（`deploy/README.md`） | — |
| `docs/` | 設計メモ（`search.md` = 検索の設計と運用、`collect.md` = collector の設計と運用） | — |

処理ロジックは `packages/core` に寄せる。CLI・API・worker に同じ処理を重複して書かない。

## 2. 開発

- ランタイムは Bun。Python・Node 専用ツールをアプリコードに持ち込まない。
- 確認: `bun run typecheck && bun test`。変更を終える前に必ず通す。
- CLI の実行: `bun run kb <cmd>`。`KB_ROOT` にデータリポジトリ（`~/git/my-knowledge`）を指定する。
- 主な環境変数: `KB_ROOT`, `KB_DB`, `KB_LANCE`, `LANCE_LANGUAGE_MODEL_HOME`, `KB_EMBED`（API pod では `off`）。
- `main` への push で GHCR にイメージがビルドされ、CI が `deploy/helm/kb-api/values.yaml` の `image.tag` をその sha に書き換えて commit する。Argo CD がそれを同期してデプロイする（`.github/workflows/image.yml`）。k8s への `kubectl apply` は手で行わない。

## 3. 検索（LanceDB + Ollama + Lindera）

- 埋め込みと LanceDB は Mac だけ。API pod は `KB_EMBED=off` で SQLite のキーワード検索に縮退する。Ollama や LanceDB を k8s で動かす案は、ユーザーが言い出さない限り出さない。
- `@lancedb/lancedb` は完全固定。上げるときは必ずスキル `upgrade-lancedb` に従う（同梱 lindera と辞書の版合わせ、`kb embed --setup && kb embed --full`）。
- 詳細は `docs/search.md`。

## 4. 機微情報

- データリポジトリの 202/203/207 ドメインは git-crypt で暗号化されている。テスト fixture・ログ・エラーメッセージにその内容を出さない。
- トークン・鍵（collector の `GITHUB_TOKEN` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`, `WORKER_TOKEN`, `INGEST_TOKEN`, `VAPID_PRIVATE_KEY`, deploy key, git-crypt key, Access のサービストークン）はコミットしない。k8s Secret と 1Password に置く。

## 5. スキル

スキルは `.agents/skills/<name>/SKILL.md`（Agent Skills 標準）。`.claude/skills`・`.codex/skills`・`.gemini/skills` はその symlink。
SKILL.md には手順と判断基準だけを書き、特定ツールの名前（Read, Edit など）は書かない。

| スキル | 用途 |
|---|---|
| `upgrade-lancedb` | `@lancedb/lancedb` の更新（lindera の版合わせと索引の再構築） |
