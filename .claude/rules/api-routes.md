---
paths:
  - "apps/api/src/**"
---

# API ルートのルール

- ルートは `createApp({ adapterFactory, sessionStore })` で依存注入する。テストは `@tsmyadmin/adapter/testing` の `FakeAdapter` を注入し `app.request()` で呼ぶ（DB 不要）
- リクエスト/レスポンスの形は **先に `packages/shared` の Zod スキーマを定義**し、`@hono/zod-validator` で検証する。web は `hc<AppType>` の型だけを見る（ファイルダウンロードのようにブラウザのナビゲーションで開くエンドポイントは例外。クエリは shared の Zod で検証し、web 側は URL ビルダー関数 + `<a href download>` を使う）
- `mysql2` / `pg` を import しない（`check:arch` が fail）。DB 操作はすべて adapter 経由
- エラーは `lib/errors.ts` で `{ code, message, detail }` に正規化する。`AdapterError.code` → HTTP: `AUTH_FAILED`/`UNAUTHENTICATED` 401、`CONNECTION_FAILED` 502、`NOT_FOUND` 404、`VALIDATION` 400、`KEY_MISMATCH`/`QUERY_FAILED` 409/400
- セッション: Cookie には署名付き ID のみ。資格情報は `session/store.ts`（メモリ、TTL）にだけ置き、レスポンスに `password` を含めない
- DDL は `/ddl/preview` で SQL を返すだけ。実行は `/sql` を通す（ユーザーがプレビューを確認してから）
