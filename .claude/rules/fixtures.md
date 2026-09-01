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
- ホストポートは MySQL `13306`、PostgreSQL `15433`（既定ポートは他のスタックが使用中）
