# tsmyadmin

MySQL / PostgreSQL 両対応の、モダン TypeScript 製の Web DB 管理ツール（画面構成は phpMyAdmin に倣う）。

**はじめて読む人へ**: 起動は README の「すぐ使う（開発環境）」、全体の見取り図は [docs/architecture.md](docs/architecture.md) の「最初に読む 5 つ」から。このファイルは、規則と数字の一覧です（順に読むものではありません）。

## 構成

- **モノレポ (Bun workspaces)**: `apps/api`（Hono on Bun, :3100）/ `apps/web`（Vite + React 19 + TanStack, :5175）/ `packages/shared`（Zod DTO）/ `packages/adapter`（DB 抽象層）
- **DB 抽象**: `DatabaseAdapter` を `mysql2` / `pg` の上に薄く実装。ORM 不使用（Prisma は不採用）。閲覧・CRUD・SQL 実行・DDL・エクスポート（`showCreateTable`/`iterateRows`/`exporter`）・インポート（`insertRows`）・アカウント（`listUsers`/`showGrants`/`canManageAccount`/`users` ビルダー）・サーバー情報（`serverInfo`/`listVariables`/`listStatus`/`listProcesses`/`killProcess`/`serverCatalog`/`replicationInfo`）を両方言で同じ契約に揃える
- **画面構成**: phpMyAdmin と同じ 3 階層（サーバー: DB 一覧/SQL/ステータス/変数/プロセス/ユーザー、DB: 構造/SQL/エクスポート/インポート/権限/ルーチン/トリガー/イベント、テーブル: 表示/構造/SQL/検索/挿入/エクスポート/インポート/トリガー/操作）
- **型の流れ**: `packages/shared` の Zod → API (`@hono/zod-validator`) → web (`hc<AppType>`)
- **テスト DB**: `docker compose`（MySQL `13306` / PostgreSQL `15433`、fixtures 自動投入）
- **開発での使い方（売りの機能）**: `docker-compose.dev.yml` 1 つで、手元の Docker の MySQL / PostgreSQL コンテナを自動検出してログイン画面に出す（`TSMYADMIN_DOCKER_DISCOVERY=1`、`apps/api/src/lib/docker-discovery.ts`。読むのは GET だけ、パスワードは既定では読まない（`TSMYADMIN_DOCKER_LOGIN=1` を明示したときだけコンテナの資格情報をプロセス内に読み、ブラウザには返さず 1 クリックで入る）、`NODE_ENV=production` では拒否）
- **本番運用**: 設定は `apps/api/src/config.ts` で起動時検証（環境変数の一覧は `docs/deployment.md` が唯一の正）。接続先 allowlist・ログイン レート制限・CSP・リクエスト ID 付き構造化ログ・監査ログ（`withAudit`）・`/healthz` `/readyz`・暗号化 SQLite セッションストア（`SESSION_STORE=sqlite`）
- **品質**: Vitest / Playwright（**アクセシビリティ**は 3 層で、Biome の a11y ルール（警告 0 を維持）・`check:contrast`・E2E の axe とレイアウト検査。検査の中身と、画面を足したときにやることは [.claude/rules/web.md](.claude/rules/web.md) の「画面を足すとき」）/ Biome / knip / madge / jscpd / type-coverage + 自前検査（`check:arch`, `check:sql-safety`, `check:doc-comments` = doc コメントが別の宣言の上に残っていないか, `check:file-size` = ファイルが 800 行を超えないか（既存の大きなファイルは基準線で「増やさない」）, `docs:validate`, `size` = 初期 JS の brotli 合計 170 kB 予算）

## 開発コマンド

```bash
bun run db:up             # テスト DB 起動（初回は fixtures 投入）
bun run db:reset          # ボリューム削除して再作成
bun run dev               # api + web 同時起動
bun run check             # 型 + lint + ユニット/API/Web テスト + type-coverage（日常ゲート）
bun run check:static      # check + knip + circular + cpd + arch + sql-safety + docs + i18n + contrast + doc-comments + file-size（pre-push で実行、DB 不要）
bun run check:all         # check:static + 両 DB の統合テスト
bun run test              # DB 不要のテスト
bun run test:integration  # 両 DB の adapter conformance + API 統合（compose 必須）
bun run check:coverage    # サーバー側のカバレッジの下限（単体 + 両 DB を測り、基準線と比べる。compose 必須。CI の integration ジョブで回る）
bun run test:e2e          # Playwright
bun run test:e2e:coverage # Playwright（Chromium）で、Web のコードのどこまで実行されるかを測る（約 7 分。画面ごとの割合と、一度も実行されないファイル）
bun run lighthouse        # Lighthouse CI（警告のみ、要 Chrome）
```

## 現在の規模（`scripts/validate-docs.mjs` が同期）

- ユニット/API/Web テスト定義: <!-- stat:unit-tests -->1095<!-- /stat --> 件
- Adapter conformance: <!-- stat:conformance -->200<!-- /stat --> 件 × 2 方言
- E2E: <!-- stat:e2e -->202<!-- /stat --> 件
- API ルート: <!-- stat:routes -->95<!-- /stat -->

## 設計ドキュメント

- [docs/dev-environment.md](docs/dev-environment.md) — 開発環境向けに足した機能（実行された文・スナップショット・ワンクリック ログイン・診断）と、見送った判断（MCP など）、次の候補、既知の限界
- [docs/architecture.md](docs/architecture.md) — 設計の全体像（Mermaid 図）。パッケージ依存の向き、アダプター層の契約、セッションと接続プール、行の閲覧 / SQL 実行 / DDL の流れ、エクスポート・インポート、品質ゲート、逆引き表

## 詳細ルール（path-scoped）

- [.claude/rules/adapter.md](.claude/rules/adapter.md) — `packages/adapter/**`
- [.claude/rules/api-routes.md](.claude/rules/api-routes.md) — `apps/api/src/**`
- [.claude/rules/fixtures.md](.claude/rules/fixtures.md) — `docker/**`
- [.claude/rules/web.md](.claude/rules/web.md) — `apps/web/**`
- [.claude/rules/skill-scoping.md](.claude/rules/skill-scoping.md) — `.claude/{skills,agents}/**`

## Compact Instructions

IMPORTANT: コンテキスト圧縮後も以下を必ず守ること。

- **YOU MUST** 識別子は `quoteIdent`/`quoteTable`、値はプレースホルダ（`Params`）。SQL を文字列補間で組み立てない（`bun run check:sql-safety` が fail する）
- **YOU MUST** `mysql2` / `pg` の import は `packages/adapter/src/**` の中だけ（`bun run check:arch` が fail する）
- **YOU MUST** `DatabaseAdapter` にメソッドを追加したら、次の 4 つを同時に足し、**MySQL と PostgreSQL 両方**で通す: ① `types.ts` の `ADAPTER_METHOD_NAMES`、② `packages/adapter/src/test/conformance/` の該当するグループのファイルの `describe('<method>')`（実行側は `test/conformance.ts`）、③ `packages/adapter/src/testing/fake-adapter.ts` の実装（API のテストが使う）、④ `apps/api/src/lib/audit.ts` の `AUDITED_METHODS` か `PASSTHROUGH_METHODS` への分類（`audit.test.ts` が検査）。足す前に、既存のメソッドで足りないか確認する（例: `tableStats` はすでに `indexBytes` を返す）
- **YOU MUST** `DdlOp` を追加したら `test/ddl.test.ts` の `SAMPLE_OPS` に両方言のスナップショットを追加する
- **YOU MUST** API の入出力は先に `packages/shared` の Zod スキーマを定義し、web は `hc<AppType>` 経由でのみ呼ぶ（例外: ダウンロード等ブラウザのナビゲーションで開く GET は URL ビルダー経由の `<a href>` 可）
- **YOU MUST** DDL は `/ddl/preview` → ユーザー確認 → `/sql` 実行、アカウント操作は `/users/preview`（パスワードはマスク）→ `/users/execute`。プレビューなしで実行する UI を作らない（`usePreviewFlow` + `PreviewDialog` を使う）
- **YOU MUST** 対応する置き場所（リバースプロキシ / クラウド）を `docs/hosting.md` に足したら、`apps/api/src/platform-conformance.test.ts` の `PLATFORMS` にも同じ行を足す（前段がクライアント IP をどう伝えるかは静かに壊れるため、テストで押さえる）
- **YOU MUST** 環境変数を追加したら `apps/api/src/config.ts`・`.env.example`・`docs/deployment.md` の 3 か所を同時に更新する（表は deployment.md だけに置き、他は参照する）。英訳 `docs/en/deployment.md` も直し、`bun run docs:sync` でハッシュを打ち直す
- **YOU MUST** `docs/*.md` と `README.md`（日本語が原文）を変えたら `docs/en/` / `README.en.md` の対応箇所も訳し、`bun run docs:sync` を実行する（`bun run check:static` の `docs:i18n` が fail する）
- **YOU MUST** ログにパスワード・行の値・SQL 全文を出さない（イベント名 + 識別子 + 要約のみ）
- **YOU MUST** フィクスチャ（`docker/fixtures/**`）を変えたら `bun run db:reset`。既存の checkout でも MySQL の `WITH GRANT OPTION` 追加以降はリセットが必要
- **YOU MUST** web の UI 文字列は `apps/web/src/config/locales/{ja,en}.ts` の両方に定義し（`en.ts` は `satisfies Locale` で型が揃う）、`locale.*` で参照する。Tailwind の色指定には `dark:` 対応を付ける
- **YOU MUST** E2E は本番ビルドを API が配信する。Playwright のプロジェクトは `chromium`（機能）/ `webkit`（機能・Safari 差分）/ `a11y` / `visual-light` / `visual-dark`。**ビジュアルの 2 つはローカル専用**で、CI は `chromium` / `a11y` / `webkit` だけを実行する（スナップショットは `-darwin` のみ。OS が変わると描画差で落ちるため）。したがって見た目の退行はローカルで `bun run test:e2e` を回したときにしか検出されない。`bun run test:e2e` は毎回ビルドするが、ポート 3199 / 3198（永続セッションストアの検証用）に古いサーバーが残っていると再利用される（`reuseExistingServer`）ので、web を変更したら `bun run build` してから実行するか、残っているサーバーを止める
- **YOU MUST** 1 ファイル 800 行を超えない（`bun run check:file-size` が fail する）。超えそうなら、中身で分ける。既存の大きなファイルは `scripts/file-size-baseline.json` に理由つきで記録してあり、**増やさず、縮めたら基準線を下げる**（`-- --update-baseline` は下げるだけ）。基準線に足す・数を上げるのは、分けられない理由を書いたうえでの手作業にする
- **YOU MUST** 利用者に見える変更（機能・挙動・文言・対応バージョン）は `CHANGELOG.md` の `[Unreleased]` に追記する
- **YOU MUST** 統合テストは `*.integration.test.ts` 命名（DB 不要の `bun run test` / pre-commit から除外される）
