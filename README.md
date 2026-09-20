# tsmyadmin

*English: [README.en.md](README.en.md)*

**開発環境の Docker で動いている MySQL / PostgreSQL を、接続先を書かずにブラウザで開ける** phpMyAdmin クローン（TypeScript 製、MySQL / PostgreSQL 両対応）。

## すぐ使う（開発環境）

必要なのは Docker だけです。

```bash
git clone https://github.com/ip-san/tsmyadmin.git && cd tsmyadmin
docker compose -f docker-compose.dev.yml up -d --build
```

<http://localhost:3100> を開くと、いま Docker で動いている MySQL / MariaDB / PostgreSQL のコンテナが、ログイン画面に `docker: プロジェクト/サービス` の名前で並びます。選んで、そのプロジェクトのユーザー名とパスワードを入れるだけです。

- 他のプロジェクトの `docker compose up` で立ち上げた DB を、ホストに公開しているポートから自動で見つけます（後から起動したものも、ログイン画面を開き直すと出ます）。接続先の書き方も、ネットワークの設定も要りません
- 読むのはコンテナの一覧とデータベース名だけで、**パスワードは読みも保存もしません**
- **開発専用**です。Docker ソケットを渡す（ホストの root 相当）ため、`NODE_ENV=production` では起動しません。仕組みと注意（Linux の公開ポート、ソケットの権限）は [docs/deployment.md](docs/deployment.md#docker-で開発用に使うコンテナの自動検出)
- 特定の DB だけ決め打ちで出したいとき、本番に置くときは、接続先プリセットと許可リスト（[docs/deployment.md](docs/deployment.md#環境変数唯一の一覧)）を使います

## 特長


UI は日本語 / English（ブラウザの言語設定に追従、画面右上で切替）。対応: **MySQL 8.0〜9**、**MariaDB 10.11 (LTS) / 11**、**Percona Server 8.4**、**PostgreSQL 14〜18**（MySQL 8.0 / 8.4、MariaDB 10.11 / 11、PostgreSQL 14 / 17 は CI で毎回検証。MySQL 9・PostgreSQL 18・Percona は手動検証。互換エンジン（TiDB / CockroachDB）の実測結果を含む詳細は [docs/deployment.md](docs/deployment.md#対応データベース)）。

- **Bun workspaces モノレポ**: `apps/api`（Hono）/ `apps/web`（Vite + React 19 + TanStack Router/Query）/ `packages/shared`（Zod DTO）/ `packages/adapter`（`mysql2` / `pg` 上の薄い DB 抽象層。ORM 不使用）
- **phpMyAdmin と同じ画面構成**: サーバー（データベース / SQL / ステータス / 変数 / プロセス / ユーザー）→ データベース（構造 / SQL / エクスポート / インポート / 権限 / ルーチン / トリガー / イベント）→ テーブル（表示 / 構造 / SQL / 検索 / 挿入 / エクスポート / インポート / トリガー / 操作）
- **機能**
  - 接続: **Docker コンテナの自動検出（開発用）**、管理者が定義する接続先プリセット、Cookie セッション
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

## このリポジトリの開発

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
- `scripts/validate-docs.mjs` — （上記に加えて）Cloudflare の worker が転送するポートと `Dockerfile` の `EXPOSE` の一致
- `scripts/check-contrast.mjs` — デザイン トークンの全組み合わせが WCAG のコントラスト比を満たすか（`--self-test` 付き。axe はテキストしか見ず、しかもテストが描画した組み合わせしか見ないため）
- `scripts/check-translations.mjs` — 英語ドキュメントが日本語の原文の更新に追随しているか（`--self-test` 付き。翻訳後に `bun run docs:sync` でハッシュを打ち直す）

`packages/adapter/src/test/conformance.ts` は 1 つのテストスイートを MySQL / PostgreSQL の両方に対して実行し、方言差を吸収できているかを保証します。

## 未実装（次の候補）

特にありません。複数レプリカ向けの共有セッションストアは `SESSION_STORE=redis` として実装済みです（共有されるものとされないものは [docs/deployment.md](docs/deployment.md#複数レプリカ) を参照）。

## 本番で使う場合（任意）

まず想定しているのは開発環境ですが、本番で動かすための守り（接続先の許可リスト、ログインのレート制限、CSP、監査ログ、暗号化したセッションストア）も備えています。

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

英語版は [README.en.md](README.en.md) と `docs/en/` にあります（日本語が原文で、`bun run docs:i18n` が追随を検査します）。

**利用者**

- [docs/user-guide.md](docs/user-guide.md) — 画面と操作のガイド、値の表し方、制限事項
- [docs/phpmyadmin-parity.md](docs/phpmyadmin-parity.md) — phpMyAdmin との機能対応表（残りの差と、作らないものの理由）

**運用・導入**

- [docs/deployment.md](docs/deployment.md) — 環境変数一覧、Docker / compose 例、リバースプロキシと TLS、対応データベース、サイズと制限
- [docs/hosting.md](docs/hosting.md) — どこで動かすか（さくらの VPS などのサーバー、AWS、Azure）。置き場所ごとに違うところだけ
- [docs/cloudflare.md](docs/cloudflare.md) — Cloudflare Containers での構築とデプロイ、Workers では動かない理由、Tunnel / Access で入口だけ置く構成
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
