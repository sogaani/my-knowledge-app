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
| `search.ts` | vector top-k + FTS top-k → RRF(k=60、vector だけが拾った `thin` chunk は 0.5 倍）→ ノート単位に集約 → SQLite の frontmatter で残りの条件を評価。Lance/Ollama 不在時は SQLite キーワード検索（`keywordSearch`）に degrade |
| `query.ts` | `kb query --text` と API の `GET /api/notes?text=`、および上の縮退経路が使う SQLite 検索。`queryTerms` が辞書なしでクエリを語に割る |

## chunk の作り方（`CHUNKER_VERSION = 2`）

埋め込みと BM25 に効くノイズを chunk の段階で落とす。ルールを変えたら `CHUNKER_VERSION` を上げる（`meta.json` の `chunker` と食い違うと次の `kb embed` が全再構築する）。

- 本文先頭の `# タイトル` 行は捨てる（タイトルと同じか、タイトルを含む行。`# 2026-10 予定`、log.md の `# X — ログ` も対象）。header chunk が title を持つので、`# KDDI` だけの chunk が header と二重に当たることはない。
- URL は `text`（FTS・snippet）と `embedText` の両方から剥がす。`[text](url)` → `text`、`![alt](url)` → `alt`、`<https://…>` と裸 URL は削除。`splitLong` の前に剥がすので、ハード分割で URL の断片が残らない。location_log の日別テーブルは店名だけが残る。
- `embedText` の先頭に付く文脈は title と tags だけ。summary は header chunk にだけ入れる（books の多くが同じ定型 summary を持つため、全 chunk に付けると本同士の chunk が似通う）。header chunk の `embedText` は header chunk そのもの（title を H1 にしたもの）。
- 空の `> [!spoiler]- ネタバレ`（テンプレートの placeholder。本文行なし）は chunk にしない。
- 本文（と添付）から chunk が 1 つも出ないノートは header chunk に `thin=true` を立てる。`search.ts` の RRF は、vector だけが拾った thin chunk の融合スコアを `THIN_WEIGHT`（0.5）倍にする。BM25 でも当たった（タイトル・summary に語がある）thin chunk は減点しない。summary の雰囲気だけが似ている空ノートが本文のあるノートの下に落ちる一方、`5G` で『5G教科書』の空ノートが上位に残る。
- LanceDB の列 `thin`（Bool）はこの版で追加。古い索引には列がないので `VectorStore.open` はスキーマにある列だけ select し、`thin` 無しの行は減点なしで検索できる。移行は `kb embed --full`（または `chunker` 不一致による自動全再構築）。列を足す・変えるときも同じ: スキーマは `VectorStore.reset` で作り直すので、`CHUNKER_VERSION` を上げて全再構築すればよい。

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
