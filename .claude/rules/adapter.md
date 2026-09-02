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
- SQL テンプレート補間が許されるのは `base.ts`, `sql/*`, `*/ddl.ts`, `*/adapter.ts` のみ（`check:sql-safety`）
- イントロスペクションは information_schema / pg_catalog を **静的 SQL + パラメータ** で問い合わせる

## 値のワイヤー規則

| 種別 | 形 |
|------|----|
| INT/FLOAT/DOUBLE、安全範囲の BIGINT | `number` |
| 安全範囲外の BIGINT、DECIMAL、日時、JSON、ENUM/SET、配列 | `string`（DB が返すテキストそのまま。TZ 変換しない） |
| BLOB/bytea/BIT | `{ $bin: base64 }`（64KB で切り詰め） |

## 行の同一性

PK → NOT NULL 一意キー → PG は `ctid`、MySQL は全カラム一致 + `LIMIT 1`。UPDATE/DELETE はトランザクション内で `affectedRows === 1` を検証し、違えばロールバックして `KEY_MISMATCH`。既知の限界: `ctid` は物理位置なので、対象行が他セッションで更新・削除され VACUUM 後にスロットが再利用されると、古い `ctid` が別の行に一致しうる（`affectedRows === 1` では検出できない）。設計上受け入れており、UI は主キーのないテーブルの編集前に再読み込みを促す。

## 接続の返却

`executeSql` はユーザー SQL の後に `ROLLBACK` → `Conn.reset()`（MySQL: `COM_RESET_CONNECTION`、PostgreSQL: `DISCARD ALL`）を必ず行う。セッション変数・ロール・ユーザー変数・一時テーブルがプールの次の借り手に漏れてはならない（conformance の「does not leak session state」が検証）。
