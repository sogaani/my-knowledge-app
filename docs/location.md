# 滞在記録（Google マップのタイムライン）

手で投げ込むデータなので collector は使わない。解析は ingest 側（`kb location import`）。

```
スマホ: Google マップ → 設定 → タイムライン → エクスポート → Timeline.json
  └─ Mac の my-knowledge/000_inbox/ に置く（数十 MB になるので WebUI の投げ込みは使わない）
       └─ ingest スキル: kb ingest → Bronze（kind file、生 JSON のまま）
            └─ kb location import <bronze-id>         packages/core/src/location/
                 ├─ parse.ts   Android(semanticSegments) / iOS(配列, placeID) / 旧 Takeout(timelineObjects.placeVisit)
                 ├─ places.ts  Places API (New) Place Details: displayName, primaryType だけ（field mask）
                 │             900_system/cache/places.sqlite に最長 30 日キャッシュ、期限切れは毎回削除
                 │             HTTP は collect/http.ts（429・5xx は指数バックオフ + Retry-After）
                 └─ import.ts  200_silver/211_location/YYYY-MM.md（location_log、git-crypt）を作成・更新
```

- 座標はエクスポートの値を使い、API からは取らない（Places の規約: 保存してよいのは place ID だけ、緯度経度は最長 30 日）。施設名・ジャンルをノートに残すのは規約の文言と合わないことを承知のうえでの運用。
- 日付・時刻はエクスポートに付いた現地のオフセットで決める（旅行先の滞在は現地時刻）。
- エクスポートは毎回全履歴を含む。作り直す月は「ノートが無い月・直近 2 か月・未取得が残る月」だけ（`--all` で全月）。各月は Bronze にある全エクスポートから組み立て、`開始時刻 + placeId` で重複を除く。
- 1 回で API を叩くのは `max_lookups`（既定 300）件まで。残りは「（未取得）」になり、同じ ID で再実行すると埋まる。初回に何年分もの場所を一度に引いて料金が跳ねないようにするため。
- 設定は `my-knowledge/900_system/config.local.toml` の `[places]`（`api_key`、`cache_ttl_days` ≤ 30、`max_lookups`）。環境変数 `GOOGLE_MAPS_API_KEY` が優先。キーは Places API (New) だけに制限する。
