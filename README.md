# tsmyadmin

MySQL / PostgreSQL 両対応の、モダン TypeScript 製 phpMyAdmin クローン。

- **Bun workspaces モノレポ**: `apps/api`（Hono）/ `apps/web`（Vite + React 19 + TanStack Router/Query）/ `packages/shared`（Zod DTO）/ `packages/adapter`（`mysql2` / `pg` 上の薄い DB 抽象層。ORM 不使用）
- **phpMyAdmin と同じ画面構成**: サーバー → データベース（構造 / SQL）→ テーブル（表示 / 構造 / SQL / 検索 / 挿入 / 操作）
- **機能**: 接続（Cookie セッション、資格情報はサーバー側メモリ）、DB・スキーマ・テーブルのツリー、行のブラウズ（ソート・ページング・絞り込み）、行の挿入・編集（ダイアログ / インライン）・削除、SQL コンソール（CodeMirror、複数文、文ごとの結果、履歴）、DDL（テーブル作成、カラム / インデックスの追加・変更・削除、TRUNCATE / DROP — すべて生成 SQL をプレビューして確認後に実行）
- **ロスレスな値**: BIGINT / DECIMAL / 日時 / JSON はサーバーの文字列のまま、バイナリは base64、NULL と空文字を区別

## 開発

```bash
bun install
bun run db:up      # docker compose: MySQL 8.4 (localhost:13306) + PostgreSQL 17 (localhost:15433)、fixtures 自動投入
bun run dev        # API http://localhost:3100 + Web http://localhost:5175
```

ログイン例（テスト DB）: MySQL `127.0.0.1:13306` / PostgreSQL `127.0.0.1:15433`、ユーザー `tsmyadmin`、パスワード `tsmyadmin`、データベース `tsmyadmin_test`。

## 品質ゲート

```bash
bun run check            # typecheck + lint + ユニット/API/Web テスト + type-coverage（pre-push でも実行）
bun run check:all        # + knip / 循環依存 / クローン検出 / アーキテクチャ検査 / SQL 安全性検査 / docs 同期 / 両 DB の統合テスト
bun run test:e2e         # Playwright（機能 × 両方言 / axe a11y / VRT light+dark）。事前に db:up
```

自前の検査:

- `scripts/check-architecture.mjs` — レイヤー依存（web は DB ドライバに触れない、ルートはアダプター経由のみ、feature 間の直接 import 禁止）とコンポーネント行数
- `scripts/check-sql-safety.mjs` — アダプターのビルダー以外で SQL を文字列補間・連結していないか、識別子を生でクォートしていないか
- `scripts/validate-docs.mjs` — `CLAUDE.md` の統計値と実体の同期（`--fix`）

`packages/adapter/src/test/conformance.ts` は 1 つのテストスイートを MySQL / PostgreSQL の両方に対して実行し、方言差を吸収できているかを保証します。

## 本番ビルド

```bash
docker build -t tsmyadmin .
docker run -p 3100:3100 -e SESSION_SECRET=$(openssl rand -hex 32) tsmyadmin
```

単一コンテナで API が SPA を配信します。セッションはプロセス内メモリ（再起動で切れます）。

## ドキュメント

- [CLAUDE.md](CLAUDE.md) — 開発コマンド、構成、守るべき不変条件（Compact Instructions）
- `.claude/rules/` — パス別の詳細ルール（adapter / api-routes / fixtures / skill-scoping）
- `.claude/agents/`, `.claude/skills/` — quality-gate / code-reviewer / test-developer エージェント、`/self-review` / `/quality-loop` スキル
