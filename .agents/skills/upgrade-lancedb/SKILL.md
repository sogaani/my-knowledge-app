---
name: upgrade-lancedb
description: "@lancedb/lancedb のバージョンを上げる手順。同梱 lindera の版を調べて lindera.ts の LANCEDB_VERSION / LINDERA_VERSION を合わせ、辞書の再導入と索引の全再構築まで行う。「lancedb を上げて」「lancedb の更新」「Renovate/Dependabot の lancedb PR」で使う。"
---

# upgrade-lancedb

lindera（日本語形態素解析）は `@lancedb/lancedb` のネイティブバイナリに組み込まれていて、外に置くのは辞書ファイルだけ。
辞書の版がバイナリ内の lindera と違うと FTS 索引の作成・検索が失敗するか、黙って `icu` にフォールバックする。
だから **lancedb だけを上げてはいけない**。下の手順を最後まで通す。

## 手順

1. 新しい版 `<NEW>` を決める（`npm view @lancedb/lancedb version` か、指定された版）。
2. `<NEW>` に同梱の lindera の版を調べる。lancedb リポジトリのタグ `v<NEW>` の `Cargo.lock` に書かれている。
   ```sh
   curl -sfL https://raw.githubusercontent.com/lancedb/lancedb/v<NEW>/Cargo.lock | grep -A1 '^name = "lindera"$'
   ```
   - 出てこない（タグがない、lindera が外れた、lindera が 2 版ある）ときは作業を止め、ユーザーに報告する。推測で版を書かない。
3. その版の辞書が配布されているか確かめる。HTTP 200 または 302 なら OK。
   ```sh
   curl -sI -o /dev/null -w '%{http_code}\n' https://github.com/lindera/lindera/releases/download/v<LINDERA>/lindera-ipadic-<LINDERA>.zip
   ```
4. 3 か所をそろえて更新する。
   - `packages/core/package.json` の `@lancedb/lancedb`（完全固定。`^` を付けない）→ `bun install`
   - `packages/core/src/lindera.ts` の `LANCEDB_VERSION` / `LINDERA_VERSION` と、その上のコメント
   - `docs/search.md` の `lindera.ts` の行にある版番号
5. 確認する: `bun run typecheck && bun test`
6. Mac（KB_ROOT = my-knowledge）で辞書を入れ直し、索引をすべて作り直す。
   ```sh
   kb embed --setup     # 新しい版の辞書を取得。VERSION ファイルが更新される
   kb embed --full      # LanceDB を全再構築（FTS 索引も新しい辞書で作り直す）
   kb embed --check     # ok であること。tokenizer が lindera/ipadic のままで icu になっていないこと
   ```
7. 試しに検索する: `kb search "<既知の日本語の固有名詞>" --mode keyword --json` を実行し、期待するノートが返ること。
8. 変更をまとめて 1 コミットにする（lancedb の版と LINDERA_VERSION を別々のコミットに分けない）。

## 判断基準

- lindera の版が前と同じでも 4 の `LANCEDB_VERSION` は更新し、6 は実行する（lance 本体の索引形式が変わっている場合があるため）。
- `kb embed --check` が `dictionary X != lindera Y` を出したら、6 の `--setup` が終わっていない。
- API pod（k8s）は `KB_EMBED=off` で LanceDB を読まないので、辞書を配る必要はない。ただし pod の lancedb も同じ版に上がるので、デプロイして起動することは確かめる。
