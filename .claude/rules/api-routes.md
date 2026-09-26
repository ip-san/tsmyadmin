---
paths:
  - "apps/api/src/**"
---

# API ルートのルール

- ルートは `createApp(config, { store, logger?, remoteAddress?, now? })` で依存注入する（アダプターのファクトリはストアが持つ）。テストは `@tsmyadmin/adapter/testing` の `FakeAdapter` を注入し `app.request()` で呼ぶ（DB 不要）
- リクエスト/レスポンスの形は **先に `packages/shared` の Zod スキーマを定義**し、`@hono/zod-validator` で検証する。web は `hc<AppType>` の型だけを見る（ファイルダウンロードのようにブラウザのナビゲーションで開くエンドポイントは例外。クエリは shared の Zod で検証し、web 側は URL ビルダー関数 + `<a href download>` を使う）
- `mysql2` / `pg` を import しない（`check:arch` が fail）。DB 操作はすべて adapter 経由
- エラーは `lib/errors.ts` で `{ code, message, detail }` に正規化する。コードと HTTP ステータスの対応表は `lib/errors.ts` の `STATUS_BY_CODE` が唯一の正（`AUTH_FAILED` 401、`CONNECTION_FAILED` 502、`KEY_MISMATCH` 409 など）。コードを追加するときは `packages/shared` の `ApiErrorCodeSchema` と `STATUS_BY_CODE` を同時に更新する（型が網羅性を強制する）
- セッション: Cookie には署名付き ID のみ。資格情報は `session/store.ts`（メモリ、TTL）と `session/sqlite-store.ts`（`SESSION_SECRET` 由来の鍵で暗号化。本番の既定）にだけ置き、レスポンスに `password` を含めない
- DDL は `/ddl/preview` で SQL を返すだけ。実行は `/sql` を通す（ユーザーがプレビューを確認してから）。アカウント操作だけは例外で、`/users/execute` が `op` から SQL を組み立て直す（プレビューではパスワードをマスクしており、そのまま送り返せる文がないため）。レプリケーションのソース設定（`/server/replication/execute`）も同じ理由で `op` から組み立て直す（レプリケーション用のパスワードを含むため）
- スナップショットの復元（`/databases/:db/snapshots/:id/restore`）も、プレビューと実行を分ける例外（`/users/execute` と同じく、実行する SQL をブラウザから受け取らない）。ダンプは API のメモリが持っており（大きすぎてブラウザとの往復に載せられない）、プレビュー（`…/restore/preview`）は「何を削除し、いくつの文を実行するか」を返し、実行はサーバーが持つダンプを流す。スナップショットはアカウント（ユーザー・ホスト・ポート）× データベース × スキーマごとに分け、ほかのアカウントには見せない
- **保存項目の同時書き込みは CAS（compare-and-set）を通す。** `session/*-store.ts` のように「読む→変更する→書く」で状態を更新するストアは、`get()` が返す `version` を捨てずに `set()` へ引き継ぎ、競合（`false` 返却）は 409 か再試行にする。`version` を分割代入で明示的に捨ててから書く実装は「盲目上書き」になり、同時書き込みで一方が消える（second-factor.ts で3世代にわたって発生・修正済み）。**「null（全消去）に相当する分岐だけ `clear()` のような別の非 CAS 経路に逃げる」のが典型的な抜け穴**なので、CAS化のレビューでは削除・全消去の分岐を必ず個別に確認する
- 保存項目（保存済みクエリ・テンプレート・central columns 等）の一意キーは常に `identity（アカウント）× kind × name`（またはそれに準ずる組）で比較する。`name` だけで dedupe・削除・上書きしない。別データベース/別スキーマの同名項目を誤って触る事故はここが原因になる
