# 滞在記録（Google マップのタイムライン）

手で投げ込むデータなので collector は使わない。解析は ingest 側（`kb location import`）。

```
スマホ: Google マップ → 設定 → タイムライン → エクスポート → Timeline.json
  └─ Mac の my-knowledge/000_inbox/ に置く（数十 MB になるので WebUI の投げ込みは使わない）
       └─ ingest スキル: kb ingest → Bronze（kind file、生 JSON のまま。同じ内容が Bronze にあれば保存せず既存の ID を返す）
            └─ kb location import <bronze-id>         packages/core/src/location/
                 ├─ parse.ts   Android(semanticSegments) / iOS(配列, placeID)（旧 Takeout の Semantic Location History は対象外）
                 ├─ places.ts  Places API (New) Place Details: displayName, primaryType, googleMapsUri だけ（field mask。同じ料金区分）
                 │             900_system/cache/places.sqlite に 70 日キャッシュ（作り直し範囲 ≤ 62 日より長い）、期限切れは毎回削除
                 │             HTTP は collect/http.ts（429・5xx は指数バックオフ + Retry-After）
                 └─ import.ts  200_silver/211_location/YYYY-MM.md（location_log、git-crypt）を作成・更新
```

- 座標はエクスポートの値を使い、API からは取らない。キャッシュ期限（既定 70 日）は Places の規約（保存してよいのは place ID だけ、緯度経度は最長 30 日）を超える。一度取得した場所は作り直しのときに必ずキャッシュに当たるようにするための、運用者の判断。施設名・ジャンル・リンクをノートに残すのも同様。
- 日付・時刻はエクスポートに付いた現地のオフセットで決める（旅行先の滞在は現地時刻）。
- エクスポートは毎回全履歴を含む。作り直す月は「ノートが無い月・今月と先月・未取得が残る月」だけ（`--all` で全月）。月は今回のエクスポートだけから組み立てる（スマホ側が正。古いエクスポートにしか無い滞在は、作り直さない月のノートに残る）。既に取り込んだものより古いエクスポートでの作り直しは断る。
- キャッシュ期限 > 作り直し範囲なので、ある滞在の場所を初めて取得してから最後に作り直すまで（最長: 先月 1 日の滞在を今月末に作り直す 62 日）キャッシュが効く。例外は「未取得が残る月」と `--all` の作り直し、`cache_ttl_days` を 62 日未満にしたとき（`kb location import` が警告する）。
- 1 回で API を叩くのは `max_lookups`（既定 300）件まで。残りは「（未取得）」になり、同じ ID で再実行すると埋まる。初回に何年分もの場所を一度に引いて料金が跳ねないようにするため。
- 設定は `my-knowledge/900_system/config.local.toml` の `[places]`（`api_key`、`cache_ttl_days`（既定 70）、`max_lookups`）。環境変数 `GOOGLE_MAPS_API_KEY` が優先。キーは Places API (New) だけに制限する。
