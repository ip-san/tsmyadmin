---
paths:
  - "docker/fixtures/**"
  - "docker-compose.yml"
---

# テスト用フィクスチャのルール

- `docker/fixtures/mysql/*.sql` と `docker/fixtures/postgres/*.sql` は **同じ論理内容**を保つ（テーブル名・行数・値）。方言固有の型だけが異なる
- 型や行を足したら: `packages/adapter/src/test/{mysql,postgres}.integration.test.ts` の `typesRow1` と、必要なら `conformance.ts` の検証を更新する
- フィクスチャは初回起動時にだけ投入される。変更後は `bun run db:reset`（ボリューム削除 + 再作成）
- ルーチン / トリガー（`count_users`, `user_label`, `posts_before_insert`）も両方言で同名。conformance の `listRoutines` / `listTriggers` が参照する
- MySQL のみ `purge_old_posts` イベント（DISABLED）。conformance の `listEvents` が参照
- ホストポートは MySQL `13306`、PostgreSQL `15433`（既定ポートは他のスタックが使用中）
- 統合テストが作る一時テーブル・一時データベース名は、実行ごとに一意な接頭辞を付ける。`information_schema` / `pg_catalog` を素朴に前方一致（LIKE）で舐める検証は、同じ DB を共有して並列に走る他の統合テストの残骸（例: `dump_*` テーブル）を拾うことを想定して書く
