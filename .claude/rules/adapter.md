---
paths:
  - "packages/adapter/**"
---

# Adapter 層のルール

`DatabaseAdapter` は MySQL と PostgreSQL を同じ契約で扱う。方言差は **必ず** 方言ディレクトリ（`mysql/`, `postgres/`）に閉じ込め、`base.ts` は方言非依存に保つ。

## 変更時の必須手順

1. `types.ts` の `DatabaseAdapter` にメソッドを足したら `ADAPTER_METHOD_NAMES` にも追加し、`test/conformance.ts` に `describe('<method>')` を書く（spec-consistency が検出）
2. 方言ファイルを片方だけ変更しない。`mysql/x.ts` を触ったら `postgres/x.ts` の同等箇所を確認する
3. 新しい型の扱いを変えたら `docker/fixtures/*` と各 `*.integration.test.ts` の `typesRow1` を更新する
4. 検証は `bun run test`（ユニット）→ `bun run db:up && bun run test:integration`（両 DB の conformance）

## SQL 組み立て

- 識別子は `quoteIdent` / `quoteTable`、値は `Params.add()` のプレースホルダ。文字列補間で値を埋め込まない
- SQL テンプレート補間が許されるのは `base.ts`, `sql/*`, `*/{ddl,adapter,export,users,server}.ts`, `mysql/routines.ts`（許可リストは `scripts/check-sql-safety.mjs` が正）。それ以外で `.query()` に渡すテンプレートは UPPER_CASE の SQL 定数の合成だけが許され、値をクォートに隣接させる補間はどこでも禁止
- イントロスペクションは information_schema / pg_catalog を **静的 SQL + パラメータ** で問い合わせる

## 値のワイヤー規則

| 種別 | 形 |
|------|----|
| INT/FLOAT/DOUBLE、安全範囲の BIGINT | `number` |
| 安全範囲外の BIGINT、DECIMAL、日時、JSON、ENUM/SET、配列 | `string`（DB が返すテキストそのまま。TZ 変換しない） |
| BLOB/bytea/BIT | `{ $bin: base64 }`（64KB で切り詰め） |

## 行の同一性

PK → NOT NULL 一意キー → PG は `ctid`、MySQL は全カラム一致 + `LIMIT 1`。UPDATE/DELETE はトランザクション内で `affectedRows === 1` を検証し、違えばロールバックして `KEY_MISMATCH`。既知の限界: `ctid` は物理位置なので、対象行が他セッションで更新・削除され VACUUM 後にスロットが再利用されると、古い `ctid` が別の行に一致しうる（`affectedRows === 1` では検出できない）。設計上受け入れており、UI は主キーのないテーブルの編集前に再読み込みを促す。

## エクスポートの走査（`iterateRows`）

MySQL はキーセットページング（PK / NOT NULL ユニークキーで `WHERE (k) > (last) ORDER BY k LIMIT n`、キーがなければ 1 バッチ）。PostgreSQL はサーバーサイドカーソル（`DECLARE ... NO SCROLL CURSOR FOR SELECT ... FROM ONLY t`、`FETCH n`）で、キーの有無に関わらず O(N)・メモリはバッチ 1 つ分。`ONLY` により継承の親テーブルは自分の行だけを出す（pg_dump と同じ）。パーティション親（`relkind = 'p'`）は `ONLY` だと空になるので付けない。行の同一性（ブラウズ）は `hasChildren` の親で `ctid` を使わない。

## 接続の返却

`executeSql` はユーザー SQL の後に `finally` で `ROLLBACK` → `Conn.reset()`（MySQL: `COM_RESET_CONNECTION` + `SET NAMES utf8mb4`、PostgreSQL: `DISCARD ALL`）を必ず行う。セッション変数・ロール・ユーザー変数・一時テーブルがプールの次の借り手に漏れてはならない（conformance の「does not leak session state」が検証）。

`base.ts` は接続ごとに statement timeout をキャッシュし（`appliedTimeout`、`Conn.id` がキー）、方言は現在の DB / `search_path` をキャッシュする（`Conn.forget()` で破棄）。方言実装の契約: `id` はチェックアウト間で安定していること（mysql2 の promise ラッパーは毎回新しいオブジェクトなので、MySQL は `conn.connection`（コア接続）をキーにする）、`reset()` は失敗時に接続を破棄対象にすること、ユーザー SQL の前に `forgetSessionState` が呼ばれることを前提にキャッシュを持つこと。

## MariaDB

MySQL アダプターは MariaDB 10.6 以降でも動く（CI の `integration-mariadb` ジョブが mysql:8.4 と別に MariaDB 11 で conformance を回す）。差分はすべて「まず MySQL の形を試し、特定のエラーで MariaDB の形に切り替えて記憶する」方式で吸収する: `max_execution_time` → `max_statement_time`（`ER_UNKNOWN_SYSTEM_VARIABLE`）、`STATISTICS.EXPRESSION` → `NULL`（`ER_BAD_FIELD_ERROR`）、`mysql.user.account_locked` → `global_priv` の JSON（`ER_BAD_FIELD_ERROR`）。MariaDB 固有の errno（1969 など）は mysql2 に名前がないので `toAdapterError` が `ER_STATEMENT_TIMEOUT` / `ER_<errno>` を補う。`max_statement_time` は SELECT 以外も制限する（PostgreSQL の `statement_timeout` と同じ意味）。`SHOW GRANTS` に含まれるパスワードハッシュは取り除いて返す。

MySQL は接続セットアップ（`USE` と同時）でセッションの `sql_mode` から `NO_BACKSLASH_ESCAPES` を外す。mysql2 の `query()` は値をクライアント側でバックスラッシュエスケープするため、このモードのサーバーではプレースホルダが壊れる（conformance の「keeps placeholder values safe under a global NO_BACKSLASH_ESCAPES」）。`reset()` 後はグローバル値に戻るので、`forget()` により次の借用で再適用される。
