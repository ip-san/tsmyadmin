# tsmyadmin

MySQL / PostgreSQL 両対応の、モダン TypeScript 製 phpMyAdmin クローン。

## 構成

- **モノレポ (Bun workspaces)**: `apps/api`（Hono on Bun, :3100）/ `apps/web`（Vite + React 19 + TanStack, :5175）/ `packages/shared`（Zod DTO）/ `packages/adapter`（DB 抽象層）
- **DB 抽象**: `DatabaseAdapter` を `mysql2` / `pg` の上に薄く実装。ORM 不使用（Prisma は不採用）
- **型の流れ**: `packages/shared` の Zod → API (`@hono/zod-validator`) → web (`hc<AppType>`)
- **テスト DB**: `docker compose`（MySQL `13306` / PostgreSQL `15433`、fixtures 自動投入）
- **品質**: Vitest / Playwright / Biome / knip / madge / jscpd / type-coverage / size-limit + 自前検査（`check:arch`, `check:sql-safety`, `docs:validate`）

## 開発コマンド

```bash
bun run db:up             # テスト DB 起動（初回は fixtures 投入）
bun run db:reset          # ボリューム削除して再作成
bun run dev               # api + web 同時起動
bun run check             # 型 + lint + ユニット/API/Web テスト + type-coverage（日常ゲート）
bun run check:all         # check + knip + circular + cpd + arch + sql-safety + docs + 統合テスト
bun run test              # DB 不要のテスト
bun run test:integration  # 両 DB の adapter conformance（compose 必須）
bun run test:e2e          # Playwright
```

## 現在の規模（`scripts/validate-docs.mjs` が同期）

- ユニット/API/Web テスト定義: <!-- stat:unit-tests -->103<!-- /stat --> 件
- Adapter conformance: <!-- stat:conformance -->37<!-- /stat --> 件 × 2 方言
- E2E: <!-- stat:e2e -->24<!-- /stat --> 件
- API ルート: <!-- stat:routes -->14<!-- /stat -->

## 詳細ルール（path-scoped）

- [.claude/rules/adapter.md](.claude/rules/adapter.md) — `packages/adapter/**`
- [.claude/rules/api-routes.md](.claude/rules/api-routes.md) — `apps/api/src/**`
- [.claude/rules/fixtures.md](.claude/rules/fixtures.md) — `docker/**`
- [.claude/rules/skill-scoping.md](.claude/rules/skill-scoping.md) — `.claude/{skills,agents}/**`

## Compact Instructions

IMPORTANT: コンテキスト圧縮後も以下を必ず守ること。

- **YOU MUST** 識別子は `quoteIdent`/`quoteTable`、値はプレースホルダ（`Params`）。SQL を文字列補間で組み立てない（`bun run check:sql-safety` が fail する）
- **YOU MUST** `mysql2` / `pg` の import は `packages/adapter/src/**` の中だけ（`bun run check:arch` が fail する）
- **YOU MUST** `DatabaseAdapter` にメソッドを追加したら `ADAPTER_METHOD_NAMES` と `test/conformance.ts` の `describe('<method>')` を同時に追加し、**MySQL と PostgreSQL 両方**で通す
- **YOU MUST** `DdlOp` を追加したら `test/ddl.test.ts` の `SAMPLE_OPS` に両方言のスナップショットを追加する
- **YOU MUST** API の入出力は先に `packages/shared` の Zod スキーマを定義し、web は `hc<AppType>` 経由でのみ呼ぶ（例外: ダウンロード等ブラウザのナビゲーションで開く GET は URL ビルダー経由の `<a href>` 可）
- **YOU MUST** DDL は `/ddl/preview` → ユーザー確認 → `/sql` 実行。プレビューなしで実行する UI を作らない
- **YOU MUST** web の日本語文字列は `apps/web/src/config/locales/ja.ts` に定義し `locale.*` で参照する。Tailwind の色指定には `dark:` 対応を付ける
- **YOU MUST** 統合テストは `*.integration.test.ts` 命名（DB 不要の `bun run test` / pre-commit から除外される）
