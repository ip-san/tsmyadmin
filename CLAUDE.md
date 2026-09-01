# tsmyadmin

MySQL / PostgreSQL 両対応の、モダン TypeScript 製 phpMyAdmin クローン。

## 構成

- **モノレポ (Bun workspaces)**: `apps/api`（Hono on Bun, :3100）/ `apps/web`（Vite + React 19 + TanStack, :5175）/ `packages/shared`（Zod DTO）/ `packages/adapter`（DB 抽象層）
- **DB 抽象**: `DatabaseAdapter` を `mysql2` / `pg` の上に薄く実装。ORM 不使用（Prisma は不採用）。閲覧・CRUD・SQL 実行・DDL・エクスポート（`showCreateTable`/`iterateRows`/`exporter`）・インポート（`insertRows`）・アカウント（`listUsers`/`showGrants`/`users` ビルダー）・サーバー情報（`serverInfo`/`listVariables`/`listStatus`/`listProcesses`/`killProcess`）を両方言で同じ契約に揃える
- **画面構成**: phpMyAdmin と同じ 3 階層（サーバー: DB 一覧/ステータス/変数/プロセス/ユーザー、DB: 構造/SQL/エクスポート/インポート/権限、テーブル: 表示/構造/SQL/検索/挿入/エクスポート/インポート/操作）
- **型の流れ**: `packages/shared` の Zod → API (`@hono/zod-validator`) → web (`hc<AppType>`)
- **テスト DB**: `docker compose`（MySQL `13306` / PostgreSQL `15433`、fixtures 自動投入）
- **本番運用**: 設定は `apps/api/src/config.ts` で起動時検証（環境変数の一覧は `docs/deployment.md` が唯一の正）。接続先 allowlist・ログイン レート制限・CSP・リクエスト ID 付き構造化ログ・監査ログ（`withAudit`）・`/healthz` `/readyz`・暗号化 SQLite セッションストア（`SESSION_STORE=sqlite`）
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

- ユニット/API/Web テスト定義: <!-- stat:unit-tests -->158<!-- /stat --> 件
- Adapter conformance: <!-- stat:conformance -->50<!-- /stat --> 件 × 2 方言
- E2E: <!-- stat:e2e -->30<!-- /stat --> 件
- API ルート: <!-- stat:routes -->24<!-- /stat -->

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
- **YOU MUST** DDL は `/ddl/preview` → ユーザー確認 → `/sql` 実行、アカウント操作は `/users/preview`（パスワードはマスク）→ `/users/execute`。プレビューなしで実行する UI を作らない（`usePreviewFlow` + `PreviewDialog` を使う）
- **YOU MUST** 環境変数を追加したら `apps/api/src/config.ts`・`.env.example`・`docs/deployment.md` の 3 か所を同時に更新する（表は deployment.md だけに置き、他は参照する）
- **YOU MUST** ログにパスワード・行の値・SQL 全文を出さない（イベント名 + 識別子 + 要約のみ）
- **YOU MUST** フィクスチャ（`docker/fixtures/**`）を変えたら `bun run db:reset`。既存の checkout でも MySQL の `WITH GRANT OPTION` 追加以降はリセットが必要
- **YOU MUST** web の日本語文字列は `apps/web/src/config/locales/ja.ts` に定義し `locale.*` で参照する。Tailwind の色指定には `dark:` 対応を付ける
- **YOU MUST** 統合テストは `*.integration.test.ts` 命名（DB 不要の `bun run test` / pre-commit から除外される）
