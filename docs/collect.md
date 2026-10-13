# Bronze collector（データの自動収集）

外部サービスの生データを定期的に取得し、データリポジトリの `000_inbox/` に JSON で置く。そこから先は従来どおり `ingest`（`kb ingest` で Bronze へ、スキルで Silver へ）。

```
launchd daily-collect（毎朝 06:30）
  └─ bun run collect                     apps/collector（.env に秘密。Mac だけ）
       └─ runCollectors()                packages/core/src/collect/run.ts
            ├─ Promise.allSettled で各 Collector を並行実行（1 つ失敗しても他は続ける）
            │    gmail / github / calendar / youtube / health / linkedin
            ├─ HTTP は http.ts（429・5xx・レート制限の 403（GitHub の X-RateLimit、Google の rateLimitExceeded / RATE_LIMIT_EXCEEDED）だけ再試行。Retry-After / X-RateLimit-Reset を尊重、
            │   それ以外は指数バックオフ + full jitter：基準 1 秒・上限 60 秒・最大 5 回）
            ├─ 000_inbox/collect-<source>-<from>_<to>.json（フィード）/ mail-YYYYMMDD-<category>-<id>.json（Gmail）
            └─ 900_system/cache/collect-state.json（ソースごとのカーソル。失敗したソースは前回の位置から再取得）
launchd daily-ingest（07:00）→ enqueue.sh → POST /api/jobs（ingest, scheduled）→ worker
  ├─ worker は claim した ingest と一緒に、その時点で queued の ingest を全部 claim して 1 束にする（下の「ingest ジョブの束ね実行」）
  ├─ inbox が空で束が定期実行だけなら agent を起動せず skip
  └─ ingest スキル（1 回）
       ├─ kb ingest：collect-*.json → kind feed、mail-*.json → kind mail
       ├─ kb source <id>：生 JSON ではなく 1 件 1 行の要約（collect/digest.ts）。--full で生 JSON
       └─ collect-health-* は kb health import（月次 health_log を機械的に生成。エージェントは数値を写さない）
```

## ingest ジョブの束ね実行

ingest は「WebUI の投げ込み 1 件 = 1 ジョブ」で、同じ時間帯に 3 件投げれば claude が 3 回走って 3 コミットになっていた。worker はこれを 1 回にまとめる（`apps/worker/src/ingest-batch.ts` が判断、`main.ts` の `runIngest` が実行）。

1. `GET /api/worker/jobs/next` で ingest を 1 件 claim したら、続けて `POST /api/worker/jobs/claim?kind=ingest` で、その時点で queued の ingest を全部 claim する（`claimQueuedJobs`、1 トランザクション、最大 50 件）。最初の 1 件が「先頭ジョブ」。
2. `git pull --rebase` を 1 回、全ジョブの入力（WebUI のファイル・URL・メモ）を `000_inbox` に stage、agent（ingest スキル）を 1 回、`kb build` とコミットを 1 回。コミットメッセージは束の入力名を並べたもの（無ければ `ingest: inbox`）。
3. heartbeat は束の全ジョブに 30 秒ごとに送る。進捗ログは先頭ジョブに流し、他のジョブのログには「先頭ジョブ <id> と束ねた」と 1 行だけ書く。
4. `done` は各ジョブに返す。結果（`summary` / `error`・`commit`）は共通で、`result.batch` に束のジョブ id（先頭が最初）が入る。API は `batch` を見て、sync と「ジョブ失敗」の push を先頭ジョブの `done` でだけ行う（失敗の題名に「N 件束ね」が付く）。
5. 束に `scheduled` なジョブが 1 つでもあれば運用ダイジェストを組み立て、`result.digest` は全ジョブに、push（`notify`）は先頭ジョブにだけ付ける。1 束 1 通。

**アイドル時スキップ**: 束が定期実行（`scheduled`）だけで、stage 後の `000_inbox` が空（collector の出力も stage した入力も無い）なら agent を起動しない。`done` は `ok: true` で `result.summary` が「inbox が空のため skip」、`result.skipped: true`、commit なし。運用ダイジェストはこのときも送る（inbox が空 = collector が何も持ってこなかった、を朝に気づくため）。WebUI から投げた ingest（入力付き、または Inbox ページの「ingest を実行」）は束に入っていれば skip しない。

## ソース

| id | 取得するもの | 認証 | 期間 |
|---|---|---|---|
| `gmail` | Apps Script が `KB/*` ラベルを付け、まだ `KB/取込済` が無いメール。取得後に `KB/取込済` を付ける | Google OAuth（`gmail.modify`） | ラベル基準 |
| `github` | 自分が作った Issue / PR、自分のコミット（検索 API） | fine-grained PAT（読み取り専用） | 前回の終わり〜今 |
| `calendar` | 表示中のカレンダー（または `GOOGLE_CALENDAR_IDS`）の予定。キャンセル・辞退は除く。①実績: 前回の終わり〜今に行われた予定 ②将来: 今〜2 年後（`GOOGLE_CALENDAR_HORIZON_DAYS` で変更可）を毎回取得し、前回から新規・変更・削除になった予定だけを出す（繰り返しはシリーズで 1 件） | Google OAuth | ①前回の終わり〜今 ②今〜2 年後の差分 |
| `youtube` | 高評価した動画（前回からの差分）と `YOUTUBE_PLAYLIST_IDS` の再生リスト | Google OAuth | 差分（カーソルに既知 ID） |
| `health` | Google Health API v4 の日別 歩数・距離・消費カロリー・アクティブ時間（`dailyRollUp`）と睡眠（起床日で集計） | Google OAuth（`googlehealth.*.readonly` だけの別トークン。Health API は他のスコープを含むトークンを 403 で拒否する） | 完了した日だけ（昨日まで） |
| `linkedin` | inbox に置かれた `*LinkedInDataExport*.zip` のプロフィール・職歴・新しいつながり・新しいメッセージ | なし（ZIP を手で置く） | 前回のエクスポートとの差分 |

LinkedIn は自分のつながりやメッセージを返す API が EU/EEA 以外に公開されていないため、設定の「データのコピーをダウンロード」を使う。プロフィールの住所・生年月日などはフィードに写さない（ZIP 自体は Bronze に残る）。

## 初回設定

1. `cp apps/collector/.env.example apps/collector/.env` して `KB_ROOT` を書く。
2. GitHub: fine-grained PAT（対象リポジトリに Metadata / Contents / Issues / Pull requests の Read）を `GITHUB_TOKEN` に。
3. Google: GCP で Gmail API・Google Calendar API・YouTube Data API v3・Google Health API を有効化し、OAuth クライアント（種類「デスクトップ アプリ」）を作って `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に。同意画面は「テスト」のまま運用している（下の「トークンの更新」）。
4. `bun run collect auth`：ブラウザで 2 回同意する（Gmail・Calendar・YouTube 用と、Health のスコープだけの Health 用）。`GOOGLE_REFRESH_TOKEN` / `GOOGLE_HEALTH_REFRESH_TOKEN` と発行日時が `.env` に書き込まれる（トークンは画面に出ない）。
5. `bun run collect status` で各ソースが `configured` になったか確認し、`bun run collect --dry-run` で件数だけ見る。
6. データリポジトリの `900_system/scripts/launchd.sh` を再実行して `daily-collect` を入れる。
7. Gmail を切り替える：`900_system/gas/emailfilter/README.md` の「pushToInbox からの切り替え」。

秘密は `.env`（gitignore 済み）と 1Password に置く。ログには件数とエラーの種類だけを出す（件名・本文は出さない）。

## 運用

- `bun run collect [source...] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]`：手動実行。`--from` で取りこぼした期間を取り直せる。
- 同じ期間のファイルが inbox に残っている間は上書きしない（ingest 前の二重実行は無害）。Bronze 側も同じ内容なら同じ ID になる。
- ログ：`my-knowledge/900_system/logs/collect.log`。失敗したソースは `bun run collect status` の `last error` に出る。
- 401 / 403（権限）が続くとき：Google はトークン失効か同意画面がテストのまま → `bun run collect auth google` をやり直す。

## トークンの更新（同意画面が「テスト」の間）

Google は「テスト」状態のアプリのリフレッシュトークンを、同意から 7 日で失効させる（使っていても延長されない。プログラムからは更新できない）。

- 毎朝の実行（launchd）が、期限の 1.5 日前を切ったときと失効したときに macOS の通知を出す。ログ `collect.log` にも `WARN` が出る。
- 通知が来たら `bun run collect auth`（2 つとも）か `bun run collect auth google` / `auth google-health`（片方）。同意し直した時点から 7 日に延びる。
- `bun run collect status` の末尾に各トークンの発行日時・期限・残り日数が出る。
- 失効したまま実行すると、そのトークンを使うソースだけが `… expired or revoked (invalid_grant): run bun run collect auth …` で失敗し、他のソースは続行する。期間は前回の位置から取り直すので、取りこぼしは出ない（Gmail は未取得ラベル基準）。
- 同意画面を「本番環境」に公開できたら `GOOGLE_TOKEN_TTL_DAYS=0` にして警告を止める。

## 通知（Web Push）

API に VAPID 鍵があるとき（`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`）、WebUI で購読したブラウザに次を送る。送るのは API（`POST /api/worker/jobs/:id/done`）で、worker は材料を渡すだけ。内容は件数・種別・エラーの先頭だけで、メールの件名・本文やトークンは含めない。

| 通知 | 条件 | 内容 |
|---|---|---|
| `ジョブ失敗: <kind>` | `search` 以外のジョブが `ok:false` で終わったとき（agent の非 0 終了、`kb build` 失敗、例外）。束ねた ingest は先頭ジョブの分だけ 1 通（題名に「N 件束ね」） | ジョブ id の先頭 8 桁とエラーの先頭 140 文字（HTML は剥がす）。タップで `/jobs` |
| `運用ダイジェスト M/D` | launchd の `daily-ingest`（07:00）が終わったとき 1 通（inbox が空で agent を skip したときも）。`enqueue.sh` は worker の資格情報で `POST /api/jobs` するので API がペイロードに `scheduled: true` を付け、worker はそれを見てダイジェストを組み立てる（WebUI から投げた ingest には付かない）。定期実行が他の ingest と束ねられても 1 通で、先頭ジョブの `done` に付く | 収集: ソース別の件数（`collect-state.json` の `lastItems`）・失敗・36 時間以上走っていないソース / ノート: 新規・更新数（コミット前の `git status` の Silver）・未処理 Bronze 数・最終バックアップからの日数（`backup.log`、無ければ「未実施」）/ 今日見直すノート N 件（Gold `393_resurface.md` の「見直し期限」と同じ数。`resurface()` を `kb build` と共用。同じ月日の過去ノートがあればその件数も）/ agent の「判断に迷った点」の件数と 1 つ目。全文はジョブの結果（`result.digest`）に入り、Jobs ページで読める（見直しは平文ドメインの先頭 5 件をタイトル付きで。暗号化ドメインは件数のみ）。ingest が失敗したときは題名に `[失敗]` |
| `本日の売買シート` | `trade-plan` スキルが当日のシートを作ったとき（従来どおり） | — |
| `回答: <質問>` | チャット（`ask` ジョブ）の回答が届いたとき。失敗は上の「ジョブ失敗」で | 質問の先頭 60 文字が題名、回答の先頭 200 文字が本文。タップで `/chat`。開いたままのチャット画面は `GET /api/jobs/:id/wait`（long-poll、`done` で起きる）で通知を待たずに回答を出す |

ダイジェストの組み立ては `packages/core/src/ops.ts`（`buildOpsDigest` / `formatOpsDigest`）。collector 側は `runCollectors` が成功したソースの `lastItems` を `collect-state.json` に残す。worker は `kb build` の後に索引（`openDb` + `indexNotes`）を渡し、`buildOpsDigest` がそれで「今日見直すノート」を数える（`packages/core/src/resurface.ts`。索引を渡さなければその行は出ない）。

### worker の死活

- worker は `search` 以外のジョブを実行中、30 秒ごとに `POST /api/worker/jobs/:id/heartbeat` を送る（`claude -p` は終わるまで何も出力しないので、進捗ログだけでは生存が分からない）。進捗ログ（`/log`）も heartbeat 扱い。束ねた ingest は全ジョブに送る。
- API の `requeueStale` は「最後の heartbeat から 15 分」無音のジョブを `queued` に戻す（以前は開始から 60 分固定）。長い skill ジョブでも報告が続く限り二重実行されない。heartbeat を送らない古い worker が掴んだジョブは開始時刻で判定される。
- `worker.log` の各行には時刻が付く。API のエラーはステータスコードと本文の先頭 200 文字（HTML タグは剥がす）だけを記録する。

## ソースを足す

1. `packages/core/src/collect/sources/<id>.ts` に `Collector` を実装する（`configured()`・`collect()`・`digest()`）。HTTP は `ctx.http`（リトライ込み）、Google API は `googleJson(ctx.http, ctx.google, url)`。
2. `registry.ts` の `COLLECTORS` に足す。
3. 新しい秘密は `apps/collector/.env.example` に、Google のスコープは `google.ts` の `GOOGLE_SCOPES` に足す（足したら `auth google` をやり直す）。
4. データリポジトリの `ingest` スキルの分類表に `collect-<id>-*` の行を足す。
