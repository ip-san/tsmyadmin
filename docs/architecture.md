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

**なぜ 1 プロセスか** — 管理ツールは接続先ごとに資格情報を預かります。ブラウザに資格情報を持たせず、サーバー側セッションに閉じ込めるのが phpMyAdmin 以来の前提で、そのためには API が必要です。SPA を別ホストに置くと CORS と Cookie の設定が増えるだけなので、同一オリジンで配信します。

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

この向きは `scripts/check-architecture.mjs` が機械的に検査します（web からアダプターや DB ドライバーを import すると CI が落ちます）。`packages/shared` は他の内部パッケージに依存しません。

| 層 | 責務 | 触ってよい範囲 |
|---|---|---|
| `packages/shared` | Zod スキーマ = API の契約、共有型（`Cell`、`Namespace`、`DdlOp`…）、CSV の読み書き | 依存なし |
| `packages/adapter` | `DatabaseAdapter` 契約と MySQL / PostgreSQL 実装、SQL 生成、値のワイヤー変換 | `mysql2` / `pg` はここだけ |
| `apps/api` | HTTP、セッション、監査ログ、エクスポート / インポートの組み立て | アダプター経由でのみ DB へ |
| `apps/web` | 画面。`hc<AppType>` の型でのみ API を呼ぶ | サーバー実装は型しか見ない |

用語: **`hc<AppType>`** は Hono の RPC クライアント（`hono/client` の `hc`）で、`AppType` は `apps/api/src/app.ts` が export するルート定義の型です。パス・パスパラメータ・リクエストボディに型が効きます（レスポンスの型は下の「逆引き」の例を参照）。**`Namespace`** は `{ database, schema? }` で、`schema` を持つのは PostgreSQL だけです。

## 3. アダプター層

**なぜ ORM を使わないか** — 接続先のスキーマが分かるのは実行時です（利用者が任意のデータベースを開く）。コンパイル時にスキーマを固定する ORM（Prisma など）は前提が合いません。必要なのは方言ごとの SQL 生成・カタログ問い合わせ・値のワイヤー変換だけで、それをドライバー（`mysql2` / `pg`）の上に薄く置いたのが `packages/adapter` です。

方言差を 1 か所に閉じ込めるのがこの層の目的です。`base.ts` は方言非依存のロジック（キーセット走査、行キー解決、実行と結果整形、キャンセル管理）を持ち、方言固有の SQL は `mysql/` と `postgres/` にだけ置きます。

```mermaid
classDiagram
  class DatabaseAdapter {
    <<interface>>
    +dialect
    +listDatabases() / listTables() / describeTable()
    +browseRows() / insertRow() / updateRow() / deleteRows()
    +executeSql(ns, sql, opts) / cancelQuery(id)
    +iterateRows(ns, table) AsyncIterable~RowBatch~
    +showCreateTable() / listRoutines() / listTriggers()
    +listUsers() / showGrants()
    +serverInfo() / listProcesses() / killProcess()
    +ddl : DdlBuilder
    +exporter : SqlExporter
    +users : UserSqlBuilder
  }
  class BaseAdapter {
    #borrow(ns) / withConn()
    +resolveRowKey(schema)
    +executeSql(ns, sql, opts)
    +iterateRows(ns, table, opts)
  }
  note for BaseAdapter "方言に依らない部分だけ: 文の分割と逐次実行、キャンセル管理、行キーの決定、キーセット走査"
  class MysqlAdapter
  class PostgresAdapter
  DatabaseAdapter <|.. BaseAdapter
  BaseAdapter <|-- MysqlAdapter
  BaseAdapter <|-- PostgresAdapter
```

- **契約の同一性は conformance テストが保証します。** `packages/adapter/src/test/conformance.ts` は 1 つのスイートを MySQL と PostgreSQL の両方に対して実行します。`ADAPTER_METHOD_NAMES` に載ったメソッドすべてに `describe('<method>')` があることは `test/spec-consistency.test.ts` が検査するので、載せた時点で自動的に両方言のテストになります。
- **SQL の組み立て**: 識別子は `quoteIdent` / `quoteTable`、値は `Params` のプレースホルダ。文字列補間が許されるファイルは `scripts/check-sql-safety.mjs` の許可リストが唯一の正です。
- **字句解析は 1 か所**: `sql/split.ts` が公開するのは `splitStatements` / `stripComments` / `stripLeadingComments` の 3 つで、文の分割・先頭コメント除去・監査ログのマスクはすべてこれを通ります。リテラル・コメント・方言差（`#` は MySQL のみ、PostgreSQL はブロックコメントが入れ子、`E'…'` のエスケープ、`$tag$`）を知っているのは内部の `scanToken` だけです。詳しくは下の「字句解析と文の分割」を参照。

### 字句解析と文の分割

`splitStatements` は入力を 1 度だけ走査して文に切ります。「SQL を `;` で split する」では済まない箇所が多いので、仕様は `test/split.test.ts` を正とします。

| 構文 | 扱い |
|---|---|
| 文字列・識別子リテラル | 方言ごとのエスケープを解釈（PostgreSQL の `E'…'`、`$tag$…$tag$`、MySQL の `\` エスケープ） |
| コメント | `--` / `/* */`（PostgreSQL は入れ子）/ `#`（MySQL のみ）。先頭コメントは行番号を保ったまま除去できる |
| `DELIMITER` | 行に単独で書かれたときだけ有効（mysqldump 互換）。状態は `state.delimiter` で呼び出し側に返る |
| ルーチン本体 | `BEGIN … END`、PostgreSQL の `BEGIN ATOMIC`、`CASE` の入れ子を数えて 1 文にまとめる |
| `COPY … FROM stdin` | 続くデータブロックを SQL として解釈せず、`\.` までを 1 つの塊として持つ（pg_dump の既定形式） |
| psql メタコマンド | `\restrict` は捨て、それ以外は文として残す（実行時に `UNSUPPORTED`） |
| `SET sql_mode` | MySQL の `NO_BACKSLASH_ESCAPES` を追跡し、以降のリテラル解釈を切り替える（`@saved` 変数・`REPLACE`・`CONCAT` 経由も） |
| 途中で終わるファイル | `state.unterminated` で「コメントや文字列の途中で終わった」ことを返す |

**なぜ 1 度しか走査しないか** — 64 MB のダンプを複数回トークン化するとイベントループが数百 ms 単位で止まり、他の利用者のリクエストが待たされます。インポートは分割済みの結果を `ExecuteOptions.statements` でアダプターに渡します。

### 値のワイヤー形式

行は `Cell[][]`（カラム名が重複する JOIN 結果のため配列）で運びます。精度を落とさないことが最優先です。

```mermaid
flowchart LR
  db[("DB の値")] --> conv["driverValueToCell()"]
  conv --> nul["null / boolean<br/>そのまま"]
  conv --> num["number<br/>安全な整数・浮動小数"]
  conv --> str["string<br/>BIGINT / DECIMAL / 日時 / JSON"]
  conv --> bin["{ $bin } base64<br/>BLOB / bytea / BIT"]
  conv --> trunc["{ $text, length }<br/>表示上限超えのテキスト"]
  nul & num & str & bin & trunc --> ui["画面 / SQL 結果"]
  conv -. "UNCAPPED（上限なし）" .-> dump["エクスポート・カタログ読み取り"]
```

`{ $text }` は**表示専用**で、書き戻せません（`InputCell` 型が受け付けず、`toDbValue` も拒否します）。**なぜ書き戻せなくしているか** — 切り詰めた値を編集できる型にすると、利用者が気付かないまま末尾を失った値で UPDATE してしまうためです。エクスポートとカタログ読み取り（ビュー定義、`SHOW CREATE`）は上限なし（`base.ts` の `UNCAPPED`）で全文を取得します。

行キーの決め方も `base.ts` にあります（`resolveRowKey`）。主キー → NOT NULL な一意インデックス → PostgreSQL は `ctid` / MySQL は全カラム一致、の順です。ビュー・シーケンス、およびパーティションや継承の親テーブルは `none`（編集不可）になります — `ctid` は 1 つの物理リレーションの中でしか一意ではなく、親テーブルでは子ごとに重複するためです。

## 4. セッションと接続プール

```mermaid
stateDiagram-v2
  [*] --> 未ログイン
  未ログイン --> 認証中: POST /api/session
  認証中 --> 未ログイン: 認証失敗 / 許可外ホスト / 平文 HTTP / レート制限
  認証中 --> 有効: ping 成功・Cookie 発行（署名付き ID のみ）
  有効 --> 有効: リクエストごとに TTL 延長（スライディング）
  有効 --> 失効: TTL 切れ / DELETE /api/session /<br/>同一アカウントの上限超過・再ログイン
  失効 --> [*]: プール破棄
  note right of 有効
    資格情報はサーバー側のみ。
    プールはセッションごとに最大 4 接続、
    60 秒アイドルで切断（PostgreSQL は
    接続先データベースごとに 1 プール）。
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
  A->>D: describeTable（カラム・キー・制約）
  A->>D: SELECT …（表示上限つき）
  alt 絞り込みなし かつ 概算が 100,000 行超
    A->>D: COUNT を発行せずカタログの概算を使う
  else
    A->>D: COUNT(*)（LIMIT 100,001 で打ち切り → 「100,000 以上」）
  end
  A-->>R: ResultSet + total + count 種別 + キー情報
  R-->>B: JSON（BrowseResultSchema に一致）
```

**なぜ件数を 100,000 で打ち切るか** — 絞り込みつきの `COUNT(*)` はインデックスが効かないと全表走査になり、巨大テーブルでは 1 ページ表示のたびに DB を占有します。phpMyAdmin と同じく上限で数え止め、「100,000 以上」として返します（絞り込みがなければカタログの概算で足ります）。件数の種類は `CountKind`（`exact` / `estimate` / `lower_bound`）で画面まで運びます。

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
  R->>A: executeSql(sql, { queryId, onResult })
  loop 文ごと（executeSql の中）
    A->>D: 1 文実行
    A-->>R: onResult(StatementResult, index)
    R-->>B: {"type":"result","index":i,…} を 1 行
  end
  R-->>B: {"type":"done", openTransaction} または {"type":"fatal"}
  Note over R,B: 15 秒ごとに空行（プロキシ対策のハートビート）。<br/>ブラウザが切断すると R が cancelQuery を呼ぶ
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
  alt DDL
    W->>E: POST /sql（プレビューした SQL をそのまま）
  else アカウント操作
    W->>E: POST /users/execute（op を送り、サーバーが SQL を再生成）
  end
  E-->>W: 文ごとの結果（アカウント操作は rolledBack も）
```

**プレビューを経ない実行 UI を作らないこと**が不変条件です（`.claude/rules/api-routes.md`）。

実行のしかたは 2 通りに分かれます。DDL はプレビューで見せた SQL をそのまま `/sql` に送ります（利用者が見た文と実行される文が同一であることを優先）。アカウント操作は SQL を送り返さず、`/users/execute` が `op` から組み立て直します — プレビューではパスワードを `****` にマスクしているので、そのまま送り返せる文が手元にないためです。

## 6. エクスポートとインポート

エクスポートは**ストリーミング**です。1 テーブルずつカタログを読み、500 行ずつ流します。ダンプを上から順に流し込めば復元できることが要件なので、セクションの並び順そのものが仕様です（親テーブル → 子テーブル、テーブル → 外部キー → ビュー、の順に依存を解いていきます）。

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
    lh["lighthouse（警告のみ）"]
    chk --> int & ma & e2e & build & lh
  end
  pp --> chk
```

テストの層は下から: ユニット（`sql/split`、DDL スナップショット、web の純粋関数）→ **conformance**（実 DB、両方言で同一スイート）→ API 統合（実 DB、ルート単位）→ E2E（Playwright、機能 / a11y / ビジュアル）。

## 9. 逆引き: どこを変更するか

| やりたいこと | 触る場所 | 併せて必要なこと |
|---|---|---|
| API に項目を足す | `packages/shared/src/schemas/*` → `apps/api/src/routes/*` → web | Zod を先に定義。web は `hc<AppType>` 経由 |
| アダプターにメソッドを追加 | `types.ts` → `base.ts` / `mysql/*` / `postgres/*` | `ADAPTER_METHOD_NAMES` と conformance の `describe`、両方言で通す。`testing/fake-adapter.ts` に実装し、`apps/api/src/lib/audit.ts` の `AUDITED_METHODS`（データ・構造・アカウント・サーバー状態を変えるもの）か `PASSTHROUGH_METHODS` に分類する（`audit.test.ts` が網羅性を検査） |
| DDL 操作を追加 | `packages/shared/src/schemas/ddl.ts` → `*/ddl.ts` → web のフォーム | `test/ddl.test.ts` の `SAMPLE_OPS` に両方言のスナップショット、プレビュー経由の UI |
| 画面の文言を変える | `config/locales/ja.ts` と `en.ts` | 両方に同じキーを足す（`locale.test.ts` が形の一致を検査）。コンポーネントへの直書きは禁止 |
| 表示言語を追加する | `config/locale.ts` の `LOCALES` / `LOCALE_NAMES` / `LocaleCodeSchema` と `locales/<code>.ts` | `ja.ts` が型の出どころ。新しい表は `satisfies Locale` を付ける |
| 色・見た目を変える | Tailwind のクラス | `dark:` 対応を必ず付ける |
| 環境変数を追加 | `apps/api/src/config.ts` | `.env.example` と `docs/deployment.md` の表を同時に更新 |
| 新しい型のサポート | `docker/fixtures/*` → `*/values.ts` → conformance | `bun run db:reset`、両方言の `typesRow1` |

### 例: `GET /api/server/info` のレスポンスに項目を足す

型がどこからどこへ流れるかは、一度手を動かすのが早いです。`ServerInfo` に `timezone` を足す場合:

1. `packages/shared/src/schemas/server.ts` の `ServerInfoSchema` に `timezone: z.string().nullable()` を足す（契約はここが唯一の正）
2. `packages/adapter/src/{mysql,postgres}/server.ts` の `serverInfo()` が返す値に足す。戻り値の型は shared から来ているので、**片方だけだと typecheck が落ちます**
3. `packages/adapter/src/test/conformance.ts` の `describe('serverInfo')` に両方言の検証を足し、`testing/fake-adapter.ts`（API テストが使うインメモリ実装）にも値を入れる
4. `apps/api/src/routes/server.ts` は変更不要 — ルートはアダプターの戻り値をそのまま返し、**レスポンスを実行時に検証しません**。形を守るのは `apps/api/src/app.test.ts` の `ServerInfoSchema.parse(...)` です
5. `apps/web`: `lib/queries.ts` が `unwrap<ServerInfo>` のように shared の型を明示しています（`hc` の型が効くのはパス・パラメータ・ボディまでで、レスポンスは `unwrap<T>` に渡した型になります）。表示側と `config/locales/{ja,en}.ts` のラベルを足す
6. `bun run check` → `bun run db:up && bun run test:integration`

詳細な手順とチェックリストは [CLAUDE.md](../CLAUDE.md)（Compact Instructions）と `.claude/rules/` にあります。
