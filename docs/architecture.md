# アーキテクチャ

このコードベースを初めて触る開発者向けに、**どこに何があり、なぜそうなっているか**を説明します。運用は [deployment.md](deployment.md) / [operations.md](operations.md)、利用者向けは [user-guide.md](user-guide.md)、変更時に必ず守る規約は [CLAUDE.md](../CLAUDE.md) と `.claude/rules/` にあります。

## 1. 全体像

tsmyadmin は **1 プロセス**です。Bun 上の Hono が API を提供し、同じプロセスがビルド済み SPA を配信します。データベースは接続先として外部にあり、tsmyadmin 自身が持つ永続データはセッションストアだけです。

```mermaid
flowchart LR
  browser["ブラウザ<br/>React 19 SPA"]
  subgraph proc["tsmyadmin プロセス（Bun）"]
    static["静的配信<br/>apps/web/dist"]
    api["Hono API<br/>/api/*"]
    store[("セッションストア<br/>SQLite（暗号化）")]
    pools["接続プール<br/>セッションごと"]
  end
  mysql[("MySQL /<br/>MariaDB")]
  pg[("PostgreSQL")]

  browser -->|"HTML / JS"| static
  browser -->|"JSON・NDJSON<br/>Cookie セッション"| api
  api --- store
  api --- pools
  pools -->|"mysql2"| mysql
  pools -->|"pg"| pg
```

**なぜ 1 プロセスか** — 管理ツールは接続先ごとに認証情報を預かります。ブラウザに資格情報を持たせず、サーバー側セッションに閉じ込めるのが phpMyAdmin 以来の前提で、そのためには API が必要です。SPA を別ホストに置くと CORS と Cookie の設定が増えるだけなので、同一オリジンで配信します。

## 2. パッケージ構成と依存の向き

```mermaid
flowchart TD
  web["apps/web<br/>React SPA"]
  api["apps/api<br/>Hono ルート・セッション"]
  adapter["packages/adapter<br/>DB 抽象・SQL 生成"]
  shared["packages/shared<br/>Zod スキーマ・共有型"]
  drivers["mysql2 / pg"]

  web -->|"hc&lt;AppType&gt; の型のみ"| api
  web --> shared
  api --> adapter
  api --> shared
  adapter --> shared
  adapter --> drivers

  web -.->|"検査で禁止"| adapter
  web -.->|"検査で禁止"| drivers
  linkStyle 6,7 stroke:#c00,color:#c00,stroke-dasharray:4 4
```

この向きは `scripts/check-architecture.mjs` が機械的に検査します（web からアダプターや DB ドライバを import すると CI が落ちます）。`packages/shared` は他の内部パッケージに依存しません。

| 層 | 責務 | 触ってよい範囲 |
|---|---|---|
| `packages/shared` | Zod スキーマ = API の契約、共有型（`Cell`、`Namespace`、`DdlOp`…）、CSV の読み書き | 依存なし |
| `packages/adapter` | `DatabaseAdapter` 契約と MySQL / PostgreSQL 実装、SQL 生成、値のワイヤー変換 | `mysql2` / `pg` はここだけ |
| `apps/api` | HTTP、セッション、監査ログ、エクスポート / インポートの組み立て | アダプター経由でのみ DB へ |
| `apps/web` | 画面。`hc<AppType>` の型でのみ API を呼ぶ | サーバー実装は型しか見ない |

## 3. アダプター層

方言差を 1 か所に閉じ込めるのがこの層の目的です。`base.ts` は方言非依存のロジック（キーセット走査、行キー解決、実行と結果整形、キャンセル管理）を持ち、方言固有の SQL は `mysql/` と `postgres/` にだけ置きます。

```mermaid
classDiagram
  class DatabaseAdapter {
    <<interface>>
    +dialect
    +listDatabases() / listTables() / describeTable()
    +browseRows() / insertRow() / updateRow() / deleteRows()
    +executeSql(ns, sql, opts) / cancelQuery(id)
    +iterateRows(ns, table) : AsyncIterable~RowBatch~
    +showCreateTable() / listRoutines() / listTriggers()
    +listUsers() / showGrants()
    +serverInfo() / listProcesses() / killProcess()
    +ddl : DdlBuilder
    +exporter : SqlExporter
    +users : UserSqlBuilder
  }
  class BaseAdapter {
    #borrow(ns) / withConn()
    #resolveRowKey(schema)
    +executeSql() 分割・実行・キャンセル
    +iterateRows() キーセット / カーソル
  }
  class MysqlAdapter
  class PostgresAdapter
  DatabaseAdapter <|.. BaseAdapter
  BaseAdapter <|-- MysqlAdapter
  BaseAdapter <|-- PostgresAdapter
```

- **契約の同一性は conformance テストが保証します。** `packages/adapter/src/test/conformance.ts` は 1 つのスイートを MySQL と PostgreSQL の両方に対して実行し、`ADAPTER_METHOD_NAMES` に載ったメソッドが両方言でテストされているかを spec-consistency テストが検査します。
- **SQL の組み立て**: 識別子は `quoteIdent` / `quoteTable`、値は `Params` のプレースホルダ。文字列補間が許されるファイルは `scripts/check-sql-safety.mjs` の許可リストが唯一の正です。
- **字句解析は 1 か所**: `sql/split.ts` の `scanToken` がリテラル・コメント・方言差（`#` は MySQL のみ、PostgreSQL はブロックコメントが入れ子、`E'…'` のエスケープ、`$tag$`）を知っており、文の分割・先頭コメント除去・監査ログのマスクがすべてこれを使います。

### 値のワイヤー形式

行は `Cell[][]`（列名の重複がある JOIN 結果のため配列）で運びます。精度を落とさないことが最優先です。

```mermaid
flowchart LR
  db[("DB の値")] --> conv["driverValueToCell()"]
  conv --> num["number<br/>安全な整数・浮動小数"]
  conv --> str["string<br/>BIGINT / DECIMAL / 日時 / JSON"]
  conv --> bin["{ $bin } base64<br/>BLOB / bytea / BIT"]
  conv --> trunc["{ $text, length }<br/>表示上限超えのテキスト"]
  num & str & bin & trunc --> ui["画面 / SQL 結果"]
  conv -. "UNCAPPED（上限なし）" .-> dump["エクスポート・カタログ読み取り"]
```

`{ $text }` は**表示専用**で、書き戻せません（`InputCell` 型が受け付けず、`toDbValue` も拒否します）。エクスポートとカタログ読み取り（ビュー定義、`SHOW CREATE`）は `UNCAPPED` で全文を取得します。

## 4. セッションと接続プール

```mermaid
stateDiagram-v2
  [*] --> 未ログイン
  未ログイン --> 認証中: POST /api/session
  認証中 --> 未ログイン: 認証失敗 / 許可外ホスト / 平文 HTTP
  認証中 --> 有効: ping 成功・Cookie 発行（署名付き ID のみ）
  有効 --> 有効: リクエストごとに TTL 延長（スライディング）
  有効 --> 失効: TTL 切れ / DELETE /api/session
  失効 --> [*]: プール破棄
  note right of 有効
    資格情報はサーバー側のみ。
    プールはセッションごとに最大 4 接続、
    60 秒アイドルで切断。
  end note
```

Cookie には署名付きセッション ID しか入りません。資格情報は `apps/api/src/session/store.ts`（メモリ）または `sqlite-store.ts`（`SESSION_SECRET` 由来の鍵で暗号化）にだけ置きます。

## 5. リクエストの流れ

### 5.1 行の閲覧（ふつうの GET）

```mermaid
sequenceDiagram
  participant B as ブラウザ
  participant R as routes/databases.ts
  participant M as session/middleware.ts
  participant A as アダプター
  participant D as DB

  B->>R: GET /api/databases/:db/tables/:t/rows?…
  R->>M: requireSession（Cookie 署名検証・TTL 延長）
  M-->>R: session（adapter を持つ）
  R->>R: Zod で検証（BrowseQuerySchema）
  R->>A: browseRows(ns, table, opts)
  A->>D: describeTable（列・キー・制約）
  A->>D: SELECT …（表示上限つき）と件数（絞り込み時は 100,001 行で打ち切り）
  A-->>R: ResultSet + total + count 種別 + キー情報
  R-->>B: JSON（BrowseResultSchema に一致）
```

### 5.2 SQL 実行（ストリーミングとキャンセル）

```mermaid
sequenceDiagram
  participant B as ブラウザ
  participant R as /sql/stream
  participant A as アダプター
  participant D as DB
  participant C as キャンセル用接続

  B->>R: POST { sql, queryId }
  R-->>B: NDJSON ヘッダー（chunked）
  loop 文ごと
    R->>A: executeSql（onResult で逐次通知）
    A->>D: 1 文実行
    A-->>R: StatementResult（statement 番号付き）
    R-->>B: {"type":"result",…} を 1 行
  end
  Note over R,B: 15 秒ごとに空行（プロキシ対策のハートビート）
  B->>R: POST /sql/cancel { queryId }
  R->>A: cancelQuery
  A->>C: KILL QUERY / pg_cancel_backend
  C->>D: シグナル
  A-->>R: 中断されたか（ループの終了を待って判定）
  R-->>B: {"cancelled": true}
```

### 5.3 DDL とアカウント操作（プレビュー必須）

```mermaid
sequenceDiagram
  participant U as 利用者
  participant W as usePreviewFlow
  participant P as /ddl/preview または /users/preview
  participant E as /sql または /users/execute

  U->>W: フォーム送信
  W->>P: op（Zod で検証）
  P-->>W: 生成された SQL（パスワードはマスク）
  W-->>U: ダイアログで SQL を提示（危険な操作は名前の再入力）
  U->>W: 実行を確認
  W->>E: 実行（サーバーが SQL を再生成）
  E-->>W: 文ごとの結果 + rolledBack
```

**プレビューを経ない実行 UI を作らないこと**が不変条件です（`.claude/rules/api-routes.md`）。生成した SQL をクライアントから送り返して実行することもしません（`/users/execute` はサーバー側で再生成します）。

## 6. エクスポートとインポート

エクスポートは**ストリーミング**です。1 テーブルずつカタログを読み、500 行ずつ流します。復元可能な順序が要件で、セクションの順序自体が仕様です。

```mermaid
flowchart TD
  s1["ヘッダー / 前文"] --> s2["Drop（PostgreSQL、依存の逆順に 1 トランザクション）"]
  s2 --> s3["シーケンス定義"]
  s3 --> s4["ルーチン（文字列本体・テーブル非依存）"]
  s4 --> s5["テーブル（親→子、CREATE + INSERT + シーケンス前進）"]
  s5 --> s6["外部キー"]
  s6 --> s7["シーケンス現在値 → OWNED BY"]
  s7 --> s8["ビュー / 行型に依存するルーチン（依存順）"]
  s8 --> s9["マテリアライズドビューの REFRESH"]
  s9 --> s10["トリガー・イベント"]
  s10 --> s11["完了マーカー（N objects）"]
```

インポートは 1 回だけ字句解析し、ラッパー文を前後に足して 1 スクリプトとして実行します。

```mermaid
flowchart LR
  file["アップロード"] --> dec["decodeUpload<br/>UTF-8 検証"]
  dec --> split["splitStatements<br/>1 回だけ分割"]
  split --> wrap["wrapScript<br/>FK 無効化 / BEGIN / 終端子 / COMMIT"]
  wrap --> exec["executeSql<br/>分割済みの文を渡す"]
  exec --> prog["onResult → 進捗 NDJSON"]
  exec --> sum["summariseRun<br/>文単位で集計"]
  sum --> warn["runWarnings<br/>CANCELLED / ROLLED_BACK…"]
```

**なぜ 1 回だけ分割するか** — 64 MB のダンプを複数回トークン化するとイベントループが数百 ms 単位で止まり、他の利用者のリクエストが待たされるためです（`ExecuteOptions.statements` で分割結果をアダプターに渡します）。

## 7. 画面側

- ルーティングは TanStack Router（`apps/web/src/routes`、`routeTree.gen.ts` は生成物）。サーバー状態は TanStack Query が唯一の持ち主で、**サーバーのデータをローカル state にコピーしません**。
- `features/*` は互いを直接 import しません（共有は `components/` と `lib/`）。
- UI 文字列は `config/locales/{ja,en}.ts` にのみ置き、`locale.*` で参照します。`en.ts` は `satisfies Locale` で日本語版と同じ形であることが型で保証されます。
- 表示言語は「利用者の選択 → ブラウザ言語 → 日本語」の順に決まり、切り替え時はページを再読み込みします（各モジュールが読み込み時に一度だけ `locale` を読むため）。

## 8. 品質ゲート

```mermaid
flowchart LR
  subgraph local["ローカル"]
    pc["pre-commit<br/>lint + 変更テスト"] --> pp["pre-push<br/>check:static"]
  end
  subgraph ci["CI"]
    chk["check（型 / lint / テスト / 静的検査）"]
    int["integration<br/>MySQL 8.0+PG 14 / 8.4+PG 17"]
    ma["integration-mariadb<br/>10.11 / 11"]
    e2e["e2e<br/>Chromium + WebKit + axe"]
    build["build（Docker / size）"]
    chk --> int & ma & e2e & build
  end
  pp --> chk
```

テストの層は下から: ユニット（`sql/split`、DDL スナップショット、web の純粋関数）→ **conformance**（実 DB、両方言で同一スイート）→ API 統合（実 DB、ルート単位）→ E2E（Playwright、機能 / a11y / ビジュアル）。

## 9. 逆引き: どこを変更するか

| やりたいこと | 触る場所 | 併せて必要なこと |
|---|---|---|
| API に項目を足す | `packages/shared/src/schemas/*` → `apps/api/src/routes/*` → web | Zod を先に定義。web は `hc<AppType>` 経由 |
| アダプターにメソッドを追加 | `types.ts` → `base.ts` / `mysql/*` / `postgres/*` | `ADAPTER_METHOD_NAMES` と conformance の `describe`、両方言で通す |
| DDL 操作を追加 | `packages/shared/src/schemas/ddl.ts` → `*/ddl.ts` → web のフォーム | `test/ddl.test.ts` の `SAMPLE_OPS` に両方言のスナップショット、プレビュー経由の UI |
| 画面の文言を変える | `config/locales/ja.ts` と `en.ts` | 直書き禁止。`dark:` 対応も必須 |
| 環境変数を追加 | `apps/api/src/config.ts` | `.env.example` と `docs/deployment.md` の表を同時に更新 |
| 新しい型のサポート | `docker/fixtures/*` → `*/values.ts` → conformance | `bun run db:reset`、両方言の `typesRow1` |

詳細な手順とチェックリストは [CLAUDE.md](../CLAUDE.md)（Compact Instructions）と `.claude/rules/` にあります。
