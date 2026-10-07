---
paths:
  - "packages/adapter/**"
---

# Adapter 層のルール

`DatabaseAdapter` は MySQL と PostgreSQL を同じ契約で扱う。方言差は **必ず** 方言ディレクトリ（`mysql/`, `postgres/`）に閉じ込め、`base.ts` は方言非依存に保つ。

## 変更時の必須手順

1. `types.ts` の `DatabaseAdapter` にメソッドを足す前に、既存のメソッドで足りないか確認する（例: `tableStats` はすでに `indexBytes` を返す）。足すなら、`ADAPTER_METHOD_NAMES` にも追加し、`testing/fake-adapter.ts` に実装し（API のテストが使う）、`apps/api/src/lib/audit.ts` の `AUDITED_METHODS` か `PASSTHROUGH_METHODS` に分類し（`audit.test.ts` が検査）、`test/conformance/` の該当するグループのファイル（`catalog` / `search-and-query` / `browse-and-insert` / `row-edits` / `sql-console` / `dump-and-export` / `row-identity-and-export` / `server` / `accounts` / `ddl-*` …）に `describe('<method>')` を書く（spec-consistency が検出）。グループは `test/conformance.ts` が元の順番で呼ぶ（あとのテストは前のテストが残したものを使うので、順番を変えない）。メソッドではなく「サーバー側で接続が切られたとき」を守る `connection-loss`（管理者の KILL / `pg_terminate_backend` を、別のアダプターから発行して再現する。コンテナは止めない）が最後にある。実行中の文は `CONNECTION_FAILED` で終わり、プールが死んだ接続を取り替えて次の要求が通ることを確かめる
2. SQL の組み立て前に、サーバーの状態を読んで埋めるもの（`copyTable` の列、`setDatabaseCollation` の表、`renameDatabase` / `copyDatabase` の中身）は、`DatabaseAdapter.prepareDdl`（`mysql/prepare-ddl.ts` と `postgres/prepare-ddl.ts`）に書く。API のルートに方言ごとの分岐を書かない（`check:dialect-leaks` が増えると落ちる）。方言の違いが複数の場所で要るなら、`packages/shared/src/capabilities.ts` に名前を付ける
3. `DdlOp` を追加したら、`test/ddl.test.ts` の `SAMPLE_OPS` に両方言のスナップショットを追加する
4. 方言ファイルを片方だけ変更しない。`mysql/x.ts` を触ったら `postgres/x.ts` の同等箇所を確認する
5. 新しい型の扱いを変えたら `docker/fixtures/*` と各 `*.integration.test.ts` の `typesRow1` を更新する
6. 検証は `bun run test`（ユニット）→ `bun run db:up && bun run test:integration`（両 DB の conformance）

## SQL 組み立て

- 識別子は `quoteIdent` / `quoteTable`、値は `Params.add()` のプレースホルダ。文字列補間で値を埋め込まない
- SQL テンプレート補間が許されるのは `base.ts`, `sql/*`, `*/{ddl,adapter,export,users,server,create-statements}.ts`, `mysql/routines.ts`（許可リストは `scripts/check-sql-safety.mjs` が正）。それ以外で `.query()` に渡すテンプレートは UPPER_CASE の SQL 定数の合成だけが許され、値をクォートに隣接させる補間はどこでも禁止
- イントロスペクションは information_schema / pg_catalog を **静的 SQL + パラメータ** で問い合わせる

## 値のワイヤー規則

| 種別 | 形 |
|------|----|
| INT/FLOAT/DOUBLE、安全範囲の BIGINT | `number` |
| 安全範囲外の BIGINT、DECIMAL、日時、JSON、ENUM/SET、配列 | `string`（DB が返すテキストそのまま。TZ 変換しない） |
| BLOB/bytea/BIT | `{ $bin: base64 }`（64KB で切り詰め） |

## 行の同一性

PK → NOT NULL 一意キー → PG は `ctid`、MySQL は全カラム一致 + `LIMIT 1`。UPDATE/DELETE はトランザクション内で `affectedRows === 1` を検証し、違えばロールバックして `KEY_MISMATCH`。既知の限界: `ctid` は物理位置なので、対象行が他セッションで更新・削除され VACUUM 後にスロットが再利用されると、古い `ctid` が別の行に一致しうる（`affectedRows === 1` では検出できない）。設計上受け入れており、UI は主キーのないテーブルの編集前に再読み込みを促す。

## SQL コンソールの行数上限

PostgreSQL は読み取り文を `SELECT * FROM (...) AS _tsmyadmin LIMIT maxRows+1` に包む（`wrapReadOnly`。リテラル・コメント内の DML キーワードは無視）。MySQL / MariaDB はスクリプト開始時に `SET SESSION sql_select_limit = maxRows+1` を発行する（`capResultRows`）。文が自分で `LIMIT` を書いている場合だけ派生テーブルにも包み、ラッパー固有のエラー（`WRAPPER_ONLY_ERRORS`）が出たら包まずに再実行する。既定で包まないのは、派生テーブルが MariaDB では内側の ORDER BY を落とし、MySQL では重複カラム名やトップレベル専用の修飾子を拒否するため。`sql_select_limit` はトップレベルの結果セットだけを制限し、リセットで既定に戻る。

## エクスポートの走査（`iterateRows`）

MySQL はキーセットページング（PK / NOT NULL ユニークキーで `WHERE (k) > (last) ORDER BY k LIMIT n`、キーがなければ `conn.stream` で 1 行ずつ受け取り `batchSize` 単位でまとめる。全件をメモリに載せることはない）。PostgreSQL はサーバーサイドカーソル（`DECLARE ... NO SCROLL CURSOR FOR SELECT ... FROM ONLY t`、`FETCH n`）で、キーの有無に関わらず O(N)・メモリはバッチ 1 つ分。`ONLY` により継承の親テーブルは自分の行だけを出す（pg_dump と同じ）。パーティション親（`relkind = 'p'`）は `ONLY` だと空になるので付けない。行の同一性（ブラウズ）はパーティション親（`partitioned`）と継承の親（`hasChildren`）で `ctid` を使わず `none`（編集不可）にする。述語つき（部分）ユニークインデックスも行を特定できないので主キー代わりには使わない。

## DDL 本体の区切り文字（DELIMITER・末尾コメント）

MySQL の DELIMITER 切り替え（`packages/shared/src/sql-script.ts`）で本体（`createRoutine`/`createTrigger`/`createEvent`）を区切り文字で包むときは、閉じ記号の前に **改行を挟む**。改行なしで直接連結すると、本体の最後の行が `--` / `#` の行コメントで終わっている場合に閉じ記号がそのコメントへ吸収され、`sql/split.ts` の `splitStatements` が区切りを認識できず、実行時にだけ構文エラーになる（プレビューでは正しく見える生成 SQL が壊れる）。この種の変更をするときは、本体が行コメントで終わるケースを `sql-script.test.ts` と `test/conformance/ddl-*.ts` の createRoutine/createTrigger/createEvent のテストに必ず含める（PostgreSQL の `dollarQuoted()` は閉じタグの前に改行を挟んでおり同じ問題は起きない）。

## 接続の返却

`executeSql`（実体は `sql-console.ts` の `ScriptRunner.execute`）はユーザー SQL の後に `finally` で `ROLLBACK` → `Conn.reset()`（MySQL: `COM_RESET_CONNECTION` + `SET NAMES utf8mb4`、PostgreSQL: `DISCARD ALL`）を必ず行う。ただしキャンセルされた実行だけは例外で、`reset()` せず `discard()` して接続を捨てる（飛んでいる KILL / cancel シグナルが次の借り手に当たらないようにするため）。`ROLLBACK` と `reset()` の最中にキャンセルが来た場合に備え、`reset()` のあとにもう一度確かめて捨てる（確認から返却までの間に I/O を挟まないこと。キャンセル側は信号を送る前に専用の接続を開くので、それ以降に来たキャンセルは終わった実行を見て何も送らない）。セッション変数・ロール・ユーザー変数・一時テーブルがプールの次の借り手に漏れてはならない（conformance の「does not leak session state」が検証）。

`base.ts` は接続ごとに statement timeout をキャッシュし（`appliedTimeout`、`Conn.id` がキー）、方言は現在の DB / `search_path` をキャッシュする（`Conn.forget()` で破棄）。方言実装の契約: `id` はチェックアウト間で安定していること（mysql2 の promise ラッパーは毎回新しいオブジェクトなので、MySQL は `conn.connection`（コア接続）をキーにする）、`reset()` は失敗時に接続を破棄対象にすること、ユーザー SQL の前に `forgetSessionState` が呼ばれることを前提にキャッシュを持つこと。

## MariaDB

MySQL アダプターは MariaDB 10.11 / 11 でも動く（CI の `integration-mariadb` ジョブが mysql:8.0 / 8.4 とは別に 10.11 と 11 の両方で conformance を回す。検証済みバージョンの一覧は `docs/deployment.md` が唯一の正）。差分はすべて「まず MySQL の形を試し、特定のエラーで MariaDB の形に切り替えて記憶する」方式で吸収する: `max_execution_time` → `max_statement_time`（`ER_UNKNOWN_SYSTEM_VARIABLE`）、`STATISTICS.EXPRESSION` → `NULL`（`ER_BAD_FIELD_ERROR`）、`mysql.user.account_locked` → `global_priv` の JSON（`ER_BAD_FIELD_ERROR`）。`max_statement_time` は SELECT 以外も制限する（PostgreSQL の `statement_timeout` と同じ意味）。`SHOW GRANTS` に含まれるパスワードハッシュは取り除いて返す。MariaDB の SEQUENCE は `TABLE_TYPE = 'SEQUENCE'` を `kind: 'sequence'` に写し、`showCreateTable` は `SHOW CREATE SEQUENCE` と `next_not_cached_value` からの `ALTER SEQUENCE … RESTART WITH` を返す（テーブル既定値の `nextval(\`db\`.\`seq\`)` はデータベース名を落とす）。PACKAGE / PACKAGE BODY は `kind: 'package' | 'package body'` として一覧に含め、`SHOW CREATE PACKAGE [BODY]` で定義を返す（作成 UI はない）。`listDependencies` は MariaDB に `VIEW_TABLE_USAGE` がないので null を返し、ダンプはビュー定義の参照で並び順を決める。MariaDB 固有の errno（1969、4000 番台）は mysql2 に名前がないか MySQL 8 の別の名前が当たっているため、最初の接続で `SELECT VERSION()` を見て MariaDB と分かったときだけ `toAdapterError` が `MARIADB_ERRNO_NAMES` / `ER_<errno>` に置き換える。PACKAGE のダンプは CI の MariaDB 11 で検証している（`SHOW CREATE PACKAGE` が sql_mode に依存しない 11.4 以降を前提）。MySQL 8 では接続ごとに `information_schema_stats_expiry = 0` を設定し、AUTO_INCREMENT・行数・サイズが 24 時間キャッシュされないようにする。

MySQL は接続セットアップ（`USE` と同時）でセッションの `sql_mode` から `NO_BACKSLASH_ESCAPES` を外す。mysql2 の `query()` は値をクライアント側でバックスラッシュエスケープするため、このモードのサーバーではプレースホルダが壊れる（conformance の「keeps placeholder values safe under a global NO_BACKSLASH_ESCAPES」）。`reset()` 後はグローバル値に戻るので、`forget()` により次の借用で再適用される。

## 試験の書き方

- 実際の DB が 1 通りにしか答えない分岐（拡張が無い、権限が無い、古い綴り、MariaDB の差）は、`test/scripted-conn.ts` の台本つきの接続で、サーバーの答えを書いて押さえる（`scripted([[/正規表現/, rows(...)]])`）。conformance は、両方言で同じ契約を確かめる場所で、エラー経路の網羅の場所ではない
- **conformance と API 統合の試験は、同じ MySQL / PostgreSQL サーバーに並行して書く。** サーバー全体の状態（`general_log`・`slow_log`・グローバル変数）を読む試験は、ほかの試験の行が混ざるので、「空である」ではなく、自分の目印（`scratch` の名前）を含む行だけを見る
- 試験が間違いに気づくかは、カバレッジでは分からない。重要なファイルを触ったら `bun run mutation -- --mutate <ファイル>` で、生き残った変異を見る（結果が変わらない書き換え＝同値の変異は、無理に殺さない）
