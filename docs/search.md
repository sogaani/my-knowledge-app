# セマンティック検索（LanceDB + Ollama + Lindera）

Silver ノートを chunk 単位で LanceDB に入れ、Ollama の dense ベクトルと Lindera トークンの BM25 を RRF で融合して検索する。
エージェント（Mac 上）は `kb search` を直接叩き、WebUI は API → Mac ワーカーの `search` ジョブ経由で同じ関数を呼ぶ。

```
Mac                                                k8s API pod (KB_EMBED=off, LanceDB を読まない)
┌─────────────────────────────────────────┐        ┌───────────────────────────────────────┐
│ Ollama :11434  bge-m3 (dense 1024)      │        │ GET /api/search?q=&mode=hybrid         │
│ 90_system/cache/lance/                  │        │   → createJob("search") → 最長 8s 待つ │
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
| `chunk.ts` | H2 節ごとに chunk。先頭に title/summary/tags/スカラー frontmatter の header chunk。`> [!spoiler]` は独立 chunk（`spoiler=true`）。`log.md`/`tasks.md` は README の chunk として取り込む。`noteHash` で増分判定 |
| `embed.ts` | Ollama `/api/embed` クライアント。モデルごとの次元・クエリ/文書プレフィックス（bge-m3 は不要）。`ping()` でモデル未取得も検知 |
| `lindera.ts` | `@lancedb/lancedb` 0.40.0 に同梱の lindera 3.0.7 と同じ版の辞書を GitHub Releases から取得し `config.yml` を書く。不在なら `icu` にフォールバック |
| `vector.ts` | LanceDB テーブル `chunks` の作成・増分更新（hash 差分で削除→追加）・FTS 索引作成・`optimize()`。`meta.json` の model/dim/tokenizer/chunker が変わったら全再構築 |
| `search.ts` | vector top-k + FTS top-k → RRF(k=60) → ノート単位に集約 → SQLite の frontmatter で残りの条件を評価。Lance/Ollama 不在時は SQLite キーワード検索に degrade |

## 運用

- `kb embed --setup` … 辞書の導入と `ollama pull`。`kb embed --check` … 状態を JSON で出す（異常なら exit 1）。
- `kb index` / `kb build` の末尾で増分埋め込み。Ollama が落ちていれば stderr に `embed: skipped (...)` を出して成功終了する。
- `@lancedb/lancedb` を上げるときは `lindera.ts` の `LANCEDB_VERSION` / `LINDERA_VERSION` を同時に更新し、`kb embed --setup && kb embed --full`。手順（同梱 lindera の版の調べ方を含む）はスキル `.agents/skills/upgrade-lancedb/SKILL.md`。
- 検索側プロセスにも辞書が必要（Lance は索引メタデータからトークナイザを再構築する）。現状は Mac だけが Lance を読むので Mac にだけ置く。
- `bge-m3` の sparse / multi-vector は使わない（Ollama が dense しか返さない）。語彙一致は Lindera + BM25 が担う。
- 固有名詞の取りこぼしが見えたら: Lindera ユーザー辞書（frontmatter の title/author から生成）か `ngram` 索引の追加を検討。
