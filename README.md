# tsmyadmin

MySQL / PostgreSQL 両対応の、モダン TypeScript 製 phpMyAdmin クローン。

UI は日本語 / English（ブラウザの言語設定に追従、画面右上で切替）。対応: **MySQL 8.0〜9**、**MariaDB 10.11 (LTS) / 11**、**Percona Server 8.4**、**PostgreSQL 14〜18**（CI で最古と最新を毎回検証。互換エンジン（TiDB / CockroachDB）の実測結果を含む詳細は [docs/deployment.md](docs/deployment.md#対応データベース)）。

- **Bun workspaces モノレポ**: `apps/api`（Hono）/ `apps/web`（Vite + React 19 + TanStack Router/Query）/ `packages/shared`（Zod DTO）/ `packages/adapter`（`mysql2` / `pg` 上の薄い DB 抽象層。ORM 不使用）
- **phpMyAdmin と同じ画面構成**: サーバー（データベース / SQL / ステータス / 変数 / プロセス / ユーザー）→ データベース（構造 / SQL / エクスポート / インポート / 権限 / ルーチン / トリガー / イベント）→ テーブル（表示 / 構造 / SQL / 検索 / 挿入 / エクスポート / インポート / トリガー / 操作）
- **機能**
  - 接続: 管理者が定義する接続先プリセット、Cookie セッション
  - 閲覧: DB / スキーマ / テーブルのツリー、行のブラウズ（ソート・ページング・絞り込み・表示カラムの選択、外部キーから参照先 / 参照元へのリンク）
  - 編集: 行の挿入（続けて挿入・複製）・編集（ダイアログ / インライン）・削除
  - SQL コンソール: CodeMirror、複数文、MySQL `DELIMITER` 対応、文ごとの結果を完了順にストリーミング表示、EXPLAIN、履歴・保存済みクエリ、結果の CSV / JSON ダウンロード、実行中のキャンセル
  - DDL: テーブル作成・名前変更・コピー、カラムの追加・変更・削除、インデックス / 外部キーの追加・削除、TRUNCATE / DROP、データベースの作成・削除、スキーマ作成（元に戻せない操作は名前の再入力で確認）
  - エクスポート / インポート: SQL / CSV / JSON、SQL スクリプトと CSV の取り込み
  - アカウント: 一覧・権限表示・作成・パスワード変更・削除、DB 単位の GRANT / REVOKE ALL
  - サーバー: ステータス・変数・プロセス一覧（KILL）、ストアドプロシージャ / 関数 / トリガーの一覧と定義表示、MySQL イベントスケジューラ（一覧・有効化 / 無効化・削除）
  - キーボードショートカット（`?` で一覧）
- **安全側の設計**: DDL・アカウント操作はすべて生成 SQL をプレビューして確認後に実行（パスワードはマスク表示）。SQL コンソールの各実行は自動コミットで、開きっぱなしのトランザクションは接続をプールへ戻す前にロールバック
- **ロスレスな値**: BIGINT / DECIMAL / 日時 / JSON はサーバーの文字列のまま、バイナリは base64、NULL と空文字を区別

## 開発

前提: **Bun 1.4 以上**（CI は 1.4.0）、**Docker**（Compose v2。`db:up` は `docker compose up --wait` を使います）、**Node**（`bun run check` などの検査スクリプトは Node で動きます）。`.env` は不要です — 既定でメモリセッション、許可ホストは `127.0.0.1,localhost` です（変数の一覧は `.env.example` と [docs/deployment.md](docs/deployment.md)）。

```bash
bun install
bun run db:up      # docker compose: MySQL 8.4 (localhost:13306) + PostgreSQL 17 (localhost:15433)、fixtures 自動投入
bun run dev        # API http://localhost:3100 + Web http://localhost:5175
```

ログイン例（テスト DB）: MySQL `127.0.0.1:13306` / PostgreSQL `127.0.0.1:15433`、ユーザー `tsmyadmin`、パスワード `tsmyadmin`、データベース `tsmyadmin_test`。

## 品質ゲート

```bash
bun run check            # typecheck + lint + ユニット/API/Web テスト + type-coverage
bun run check:static     # check + knip / 循環依存 / クローン / アーキテクチャ / SQL 安全性 / docs（pre-push で実行）
bun run check:all        # check:static + 両 DB の統合テスト
bun run test:e2e         # Playwright（Chromium / WebKit の機能 / axe a11y / VRT light+dark）。事前に db:up
bun run lighthouse       # Lighthouse CI（ログイン画面の性能 / a11y / ベストプラクティス、警告のみ。要 Chrome）
```

- E2E は初回に `bunx playwright install --with-deps chromium webkit` が必要です
- VRT のベースライン画像は macOS のものだけ（`*-darwin.png`）なので、他 OS では CI と同じ `bunx playwright test --project=chromium --project=a11y --project=webkit` を使ってください
- `bun run lighthouse` は本番ビルドを見るため、先に `bun run build` を実行してください

自前の検査:

- `scripts/check-architecture.mjs` — レイヤー依存（web は DB ドライバーに触れない、ルートはアダプター経由のみ、feature 間の直接 import 禁止）とコンポーネント行数
- `scripts/check-sql-safety.mjs` — アダプターのビルダー以外で SQL を文字列補間・連結していないか、識別子を生でクォートしていないか
- `scripts/validate-docs.mjs` — `CLAUDE.md` の統計値と実体の同期（`--fix`）

`packages/adapter/src/test/conformance.ts` は 1 つのテストスイートを MySQL / PostgreSQL の両方に対して実行し、方言差を吸収できているかを保証します。

## 未実装（次の候補）

複数レプリカで共有できるセッションストア（Redis 等）。

## 本番ビルド

```bash
docker build -t tsmyadmin .
docker run -d --name tsmyadmin \
  -p 127.0.0.1:3100:3100 \
  --stop-timeout 35 \
  -v tsmyadmin-data:/app/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e TSMYADMIN_ALLOWED_HOSTS=db.example.internal:5432 \
  tsmyadmin
```

単一コンテナで API が SPA を配信します。`TSMYADMIN_ALLOWED_HOSTS` には接続を許可する DB の `host:port` を**必ず**指定してください（既定はコンテナ自身のループバックだけなので、指定しないとどこにも接続できません）。本番では HTTPS 終端のリバースプロキシ配下に置いてください（詳細は `docs/deployment.md`）。

## ドキュメント

**利用者**

- [docs/user-guide.md](docs/user-guide.md) — 画面と操作のガイド、値の表し方、制限事項

**運用・導入**

- [docs/deployment.md](docs/deployment.md) — 環境変数一覧、Docker / compose 例、リバースプロキシと TLS、対応データベース、サイズと制限
- [docs/operations.md](docs/operations.md) — ヘルスチェック、ログイベント、エラーコード早見表、トラブルシュート、監視、バックアップ
- [docs/security.md](docs/security.md) — 前提と信頼境界、認証・セッション、接続先 allowlist、レート制限、CSP、ブラウザ側に残るデータ

**開発**

- [docs/architecture.md](docs/architecture.md) — 設計の全体像（Mermaid 図）: パッケージ依存、アダプター層、セッションと接続プール、主要リクエストの流れ、エクスポート / インポート、品質ゲート、逆引き表
- [CLAUDE.md](CLAUDE.md) — 開発コマンド、構成、守るべき不変条件（Compact Instructions）。**人間の開発者向けの規約でもあります**
- [CHANGELOG.md](CHANGELOG.md) — リリースノート
- `.claude/rules/` — パス別の詳細ルール（adapter / api-routes / fixtures / skill-scoping）
- `.claude/agents/`, `.claude/skills/` — quality-gate / code-reviewer / test-developer エージェント、`/self-review` / `/quality-loop` スキル

## 動作要件

- サーバー: Bun 1.4 以上（Docker イメージは同梱）。接続先の対応バージョンと検証状況は [docs/deployment.md](docs/deployment.md#対応データベース) を参照
- ブラウザ: 最新の Chrome / Edge / Firefox / Safari（ES2022、`<dialog>`、`dvh` 単位が必要）

## ライセンス

MIT（[LICENSE](LICENSE)）
