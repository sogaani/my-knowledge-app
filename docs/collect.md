# Bronze collector（データの自動収集）

外部サービスの生データを定期的に取得し、データリポジトリの `000_inbox/` に JSON で置く。そこから先は従来どおり `ingest`（`kb ingest` で Bronze へ、スキルで Silver へ）。

```
launchd daily-collect（毎朝 06:30）
  └─ bun run collect                     apps/collector（.env に秘密。Mac だけ）
       └─ runCollectors()                packages/core/src/collect/run.ts
            ├─ Promise.allSettled で各 Collector を並行実行（1 つ失敗しても他は続ける）
            │    gmail / github / calendar / youtube / health / linkedin
            ├─ HTTP は http.ts（429・5xx・レート制限の 403 だけ再試行。Retry-After / X-RateLimit-Reset を尊重、
            │   それ以外は指数バックオフ + full jitter：基準 1 秒・上限 60 秒・最大 5 回）
            ├─ 000_inbox/collect-<source>-<from>_<to>.json（フィード）/ mail-YYYYMMDD-<category>-<id>.json（Gmail）
            └─ 900_system/cache/collect-state.json（ソースごとのカーソル。失敗したソースは前回の位置から再取得）
launchd daily-ingest（07:00）→ worker → ingest スキル
  ├─ kb ingest：collect-*.json → kind feed、mail-*.json → kind mail
  ├─ kb source <id>：生 JSON ではなく 1 件 1 行の要約（collect/digest.ts）。--full で生 JSON
  └─ collect-health-* は kb health import（月次 health_log を機械的に生成。エージェントは数値を写さない）
```

## ソース

| id | 取得するもの | 認証 | 期間 |
|---|---|---|---|
| `gmail` | Apps Script が `KB/*` ラベルを付け、まだ `KB/取込済` が無いメール。取得後に `KB/取込済` を付ける | Google OAuth（`gmail.modify`） | ラベル基準 |
| `github` | 自分が作った Issue / PR、自分のコミット（検索 API） | fine-grained PAT（読み取り専用） | 前回の終わり〜今 |
| `calendar` | 表示中のカレンダー（または `GOOGLE_CALENDAR_IDS`）の、期間内に行われた予定。キャンセル・辞退は除く | Google OAuth | 前回の終わり〜今 |
| `youtube` | 高評価した動画（前回からの差分）と `YOUTUBE_PLAYLIST_IDS` の再生リスト | Google OAuth | 差分（カーソルに既知 ID） |
| `health` | Google Health API v4 の日別 歩数・距離・消費カロリー・アクティブ時間（`dailyRollUp`）と睡眠（起床日で集計） | Google OAuth（`googlehealth.*.readonly`） | 完了した日だけ（昨日まで） |
| `linkedin` | inbox に置かれた `*LinkedInDataExport*.zip` のプロフィール・職歴・新しいつながり・新しいメッセージ | なし（ZIP を手で置く） | 前回のエクスポートとの差分 |

LinkedIn は自分のつながりやメッセージを返す API が EU/EEA 以外に公開されていないため、設定の「データのコピーをダウンロード」を使う。プロフィールの住所・生年月日などはフィードに写さない（ZIP 自体は Bronze に残る）。

## 初回設定

1. `cp apps/collector/.env.example apps/collector/.env` して `KB_ROOT` を書く。
2. GitHub: fine-grained PAT（対象リポジトリに Metadata / Contents / Issues / Pull requests の Read）を `GITHUB_TOKEN` に。
3. Google: GCP で Gmail API・Google Calendar API・YouTube Data API v3・Google Health API を有効化し、OAuth クライアント（種類「デスクトップ アプリ」）を作って `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に。同意画面は「本番環境」に公開する（テストのままだとリフレッシュトークンが 7 日で切れる）。
4. `bun run collect auth google`：ブラウザで同意 → `GOOGLE_REFRESH_TOKEN` が `.env` に書き込まれる（画面には出ない）。
5. `bun run collect status` で各ソースが `configured` になったか確認し、`bun run collect --dry-run` で件数だけ見る。
6. データリポジトリの `900_system/scripts/launchd.sh` を再実行して `daily-collect` を入れる。
7. Gmail を切り替える：`900_system/gas/emailfilter/README.md` の「pushToInbox からの切り替え」。

秘密は `.env`（gitignore 済み）と 1Password に置く。ログには件数とエラーの種類だけを出す（件名・本文は出さない）。

## 運用

- `bun run collect [source...] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]`：手動実行。`--from` で取りこぼした期間を取り直せる。
- 同じ期間のファイルが inbox に残っている間は上書きしない（ingest 前の二重実行は無害）。Bronze 側も同じ内容なら同じ ID になる。
- ログ：`my-knowledge/900_system/logs/collect.log`。失敗したソースは `bun run collect status` の `last error` に出る。
- 401 / 403（権限）が続くとき：Google はトークン失効か同意画面がテストのまま → `bun run collect auth google` をやり直す。

## ソースを足す

1. `packages/core/src/collect/sources/<id>.ts` に `Collector` を実装する（`configured()`・`collect()`・`digest()`）。HTTP は `ctx.http`（リトライ込み）、Google API は `googleJson(ctx.http, ctx.google, url)`。
2. `registry.ts` の `COLLECTORS` に足す。
3. 新しい秘密は `apps/collector/.env.example` に、Google のスコープは `google.ts` の `GOOGLE_SCOPES` に足す（足したら `auth google` をやり直す）。
4. データリポジトリの `ingest` スキルの分類表に `collect-<id>-*` の行を足す。
