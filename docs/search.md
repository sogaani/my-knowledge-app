# セマンティック検索（LanceDB + Ollama + Lindera）

Silver ノートを chunk 単位で LanceDB に入れ、Ollama の dense ベクトルと Lindera トークンの BM25 を RRF で融合して検索する。
エージェント（Mac 上）は `kb search` を直接叩き、WebUI は API → Mac ワーカーの `search` ジョブ経由で同じ関数を呼ぶ。

```
Mac                                                k8s API pod (KB_EMBED=off, LanceDB を読まない)
┌─────────────────────────────────────────┐        ┌───────────────────────────────────────┐
│ Ollama :11434  bge-m3 (dense 1024)      │        │ GET /api/search?q=&mode=hybrid         │
│ 900_system/cache/lance/                  │        │   → createJob("search") → 最長 8s 待つ │
│   chunks (vector + FTS lindera/ipadic)  │  job   │   → 応答なし/失敗 → SQLite keyword +   │
│   meta.json (model/dim/tokenizer/ver)   │◀───────┤     degraded                            │
│   language_models/lindera/ipadic/       │ result │ GET /api/notes?text=  (SQLite FTS5, 従来)│
│ worker: search ジョブを in-process 処理  │───────▶│                                        │
│ kb search / kb embed / kb build(→embed) │        └───────────────────────────────────────┘
└─────────────────────────────────────────┘
```

## モジュール（packages/core）

| ファイル | 役割 |
|---|---|
| `chunk.ts` | H2 節ごとに chunk。先頭に title/summary/tags/スカラー frontmatter の header chunk。`> [!spoiler]` は独立 chunk（`spoiler=true`）。`log.md`/`tasks.md` は README の chunk として取り込む。`noteHash` で増分判定。ノイズ対策は下の「chunk の作り方」 |
| `embed.ts` | Ollama `/api/embed` クライアント。モデルごとの次元・クエリ/文書プレフィックス（bge-m3 は不要）。`ping()` でモデル未取得も検知 |
| `lindera.ts` | `@lancedb/lancedb` 0.40.0 に同梱の lindera 3.0.7 と同じ版の辞書を GitHub Releases から取得し `config.yml` を書く。不在なら `icu` にフォールバック |
| `vector.ts` | LanceDB テーブル `chunks` の作成・増分更新（hash 差分で削除→追加）・FTS 索引作成・`optimize()`。`meta.json` の model/dim/tokenizer/chunker が変わったら全再構築 |
| `search.ts` | vector top-k + FTS top-k → RRF(k=60、vector だけが拾った `thin` chunk は 0.5 倍）→ 距離の足切り（`cutoff`）→ ノート単位に集約して `confidence` を付ける → SQLite の frontmatter で残りの条件を評価。Lance/Ollama 不在時は SQLite キーワード検索（`keywordSearch`）に degrade |
| `query.ts` | `kb query --text` と API の `GET /api/notes?text=`、および上の縮退経路が使う SQLite 検索。`queryTerms` が辞書なしでクエリを語に割る |

## chunk の作り方（`CHUNKER_VERSION = 2`）

埋め込みと BM25 に効くノイズを chunk の段階で落とす。ルールを変えたら `CHUNKER_VERSION` を上げる（`meta.json` の `chunker` と食い違うと次の `kb embed` が全再構築する）。

- 本文先頭の `# タイトル` 行は捨てる（タイトルと同じか、タイトルを含む行。`# 2026-10 予定`、log.md の `# X — ログ` も対象）。header chunk が title を持つので、`# KDDI` だけの chunk が header と二重に当たることはない。
- URL は `text`（FTS・snippet）と `embedText` の両方から剥がす。`[text](url)` → `text`、`![alt](url)` → `alt`、`<https://…>` と裸 URL は削除。`splitLong` の前に剥がすので、ハード分割で URL の断片が残らない。location_log の日別テーブルは店名だけが残る。
- `embedText` の先頭に付く文脈は title と tags だけ。summary は header chunk にだけ入れる（books の多くが同じ定型 summary を持つため、全 chunk に付けると本同士の chunk が似通う）。header chunk の `embedText` は header chunk そのもの（title を H1 にしたもの）。
- 空の `> [!spoiler]- ネタバレ`（テンプレートの placeholder。本文行なし）は chunk にしない。
- 本文（と添付）から chunk が 1 つも出ないノートは header chunk に `thin=true` を立てる。`search.ts` の RRF は、vector だけが拾った thin chunk の融合スコアを `THIN_WEIGHT`（0.5）倍にする。BM25 でも当たった（タイトル・summary に語がある）thin chunk は減点しない。summary の雰囲気だけが似ている空ノートが本文のあるノートの下に落ちる一方、`5G` で『5G教科書』の空ノートが上位に残る。
- LanceDB の列 `thin`（Bool）はこの版で追加。古い索引には列がないので `VectorStore.open` はスキーマにある列だけ select し、`thin` 無しの行は減点なしで検索できる。移行は `kb embed --full`（または `chunker` 不一致による自動全再構築）。列を足す・変えるときも同じ: スキーマは `VectorStore.reset` で作り直すので、`CHUNKER_VERSION` を上げて全再構築すればよい。

## 関連度の足切りと confidence

RRF は順位しか見ないので、何も当たらないクエリでも `limit` 件が埋まる。`vectorSearch` / `ftsSearch` は `_distance`（cosine 距離、0 = 同一）と `_score`（BM25）を select に含めて chunk に残し（Lance は select に `_distance` を含めないと deprecation warning を出す）、融合後に次の 2 段階で使う。`--json` では `matches[].vectorDistance` / `matches[].bm25` と `hits[].confidence` に出る。

- 足切り（`cutoff`、`VECTOR_CUTOFF = 0.55`）: vector だけが拾い、距離が 0.55 より大きく、chunk の `text` にクエリの語（`queryTerms`）が 1 つも無い chunk を捨てる。BM25 が当てた chunk と語を含む chunk は距離に関係なく残す。全部落ちれば 0 件。
- `confidence`（ノート単位）: `high` = いずれかの chunk が「BM25 で当たり、かつ `text` にクエリの語を含む」か「thin でなく距離 ≤ `VECTOR_STRONG`（0.50）」。それ以外は `low`（0.50〜0.55 の vector 近傍、thin ノート、語を含まない BM25 当たり — lindera は `5G` を `5` + `G` に割るので BM25 単独は信用しない）。縮退経路（`keywordSearch`）は全語を含む（runQuery の AND 段）ノートを `high`、OR で拾ったノートを `low` にする。
- CLI は行頭に `●`（high）/ `○`（low）、vector の match に `d=0.48` を出す。WebUI は生スコアを出さず、`low` のカードを薄くして「弱い一致」バッジを付ける。ask スキルは `low` のノートを開かない。

閾値の根拠（2026-10-13、bge-m3 dense 1024、chunker v2、526 行、`archived = false` で vector top-50 を実測）:

| クエリ | 関連 chunk の距離 | 無関係 chunk の距離 |
|---|---|---|
| `Cloudflare Durable Objects` | 0.375〜0.476（学習ノートの 4 chunk、全部 BM25 も当たる） | 0.507〜（thin の本・映画が 5〜6 位） |
| `自治体DX` | 0.408〜0.520（theme と関連銘柄） | 0.577〜 |
| `5G` | 0.438〜0.497（5G 教科書 2 冊・モバイル通信の学習） | 0.565〜 |
| `ドラム式洗濯機` | 0.438〜0.542（購入プロジェクトの 4 chunk） | 0.584〜 |
| `KDDI` | 0.476〜0.604（stock と trade_plan、全部 BM25 も当たる） | 0.649〜（台帳・他 theme） |
| `孤島が舞台のミステリー` | 0.416〜0.485（該当の本）、0.515〜0.55（他のミステリ。summary に `ミステリ` を含む） | 0.563〜 |
| `量子コンピュータの冷却方式`（KB に無い話題） | — | 最近傍 0.592、BM25 0 件 |
| `フランス革命の原因`（KB に無い話題） | — | 最近傍 0.666、BM25 0 件 |

関連 chunk は 0.38〜0.55、無関係クエリの最近傍は 0.59 以上なので境界を 0.55 に置いた。0.50〜0.55 には「同ジャンルの別の本」のような弱い近傍が混じるため `high` の線は 0.50。モデル（`embedding.model`）や chunker を変えたら同じ計測をやり直す（上の表のクエリを `kb search --json` で流して `vectorDistance` を見る）。

## 縮退経路（SQLite キーワード検索）

API pod（`KB_EMBED=off`）と、Mac が応答しないときの WebUI はこの経路しか使えない。`kb search --mode keyword` は LanceDB の BM25 で別物なので、縮退経路の品質は `kb query --text` で確かめる。

- 語の切り出し（`queryTerms`）: 空白で分けた後、各片を文字種（漢字 / カタカナ / 英数）の連続で割る。ひらがなの連続（助詞・送り仮名）と 1 文字の語は捨てる。カタカナ語の末尾「ー」は落とす（ミステリ/ミステリー、サーバ/サーバー を両方拾う）。ひらがなだけの片（「おすすめ」）はそのまま残す。例: 「孤島が舞台のミステリー」→ `孤島` `舞台` `ミステリ`。
- 一致判定: 各語を title / summary / tags / body に LIKE（部分一致）で当て、含む語の数（`matched`）を数える。全語を含むノートがあればそれだけ（AND）、なければ 1 語でも含むノート（OR）を返す。trigram FTS5 は 3 文字未満の語を引けないので、2 文字の漢語（孤島・銘柄）は LIKE が担う。
- 順位: `matched` の多い順 → スコア順。スコアは、3 文字以上の語は `bm25(notes_fts, 0, 10, 5, 3, 1)`（title 10 / summary 5 / tags 3 / body 1。先頭の 0 は UNINDEXED の path 列）、2 文字の語は同じ列重みを LIKE で加算したもの。`--order` を指定すると `matched` 順の中でその並びになる。
- snippet（`keywordSearch`）: 本文（先頭の `# タイトル` 行を除く）で最初に語が出る場所の前後 160 文字と、その直前の見出し。本文に語がなければ summary。`> [!spoiler]` は `spoilers` を指定しない限り除いてから探す。

## 運用

- `kb embed --setup` … 辞書の導入と `ollama pull`。`kb embed --check` … 状態を JSON で出す（異常なら exit 1）。
- `kb index` / `kb build` の末尾で増分埋め込み。Ollama が落ちていれば stderr に `embed: skipped (...)` を出して成功終了する。
- `@lancedb/lancedb` を上げるときは `lindera.ts` の `LANCEDB_VERSION` / `LINDERA_VERSION` を同時に更新し、`kb embed --setup && kb embed --full`。手順（同梱 lindera の版の調べ方を含む）はスキル `.agents/skills/upgrade-lancedb/SKILL.md`。
- 検索側プロセスにも辞書が必要（Lance は索引メタデータからトークナイザを再構築する）。現状は Mac だけが Lance を読むので Mac にだけ置く。
- `bge-m3` の sparse / multi-vector は使わない（Ollama が dense しか返さない）。語彙一致は Lindera + BM25 が担う。
- 固有名詞の取りこぼしが見えたら: Lindera ユーザー辞書（frontmatter の title/author から生成）か `ngram` 索引の追加を検討。
