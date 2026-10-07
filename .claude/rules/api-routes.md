---
paths:
  - "apps/api/src/**"
---

# API ルートのルール

- ルートは `createApp(config, { store, logger?, remoteAddress?, now? })` で依存注入する（アダプターのファクトリはストアが持つ）。テストは `@tsmyadmin/adapter/testing` の `FakeAdapter` を注入し `app.request()` で呼ぶ（DB 不要）
- リクエスト/レスポンスの形は **先に `packages/shared` の Zod スキーマを定義**し、`@hono/zod-validator` で検証する。web は `hc<AppType>` の型だけを見る（ファイルダウンロードのようにブラウザのナビゲーションで開くエンドポイントは例外。クエリは shared の Zod で検証し、web 側は URL ビルダー関数 + `<a href download>` を使う）
- `mysql2` / `pg` を import しない（`check:arch` が fail）。DB 操作はすべて adapter 経由
- **DB の種類（MySQL / PostgreSQL）の違いを、`dialect === '…'` で書かない。** 違いが事実なら `packages/shared/src/capabilities.ts` に名前を付けて読む（識別子の長さ、トランザクションの開始、`databasesAreSchemas`、ダンプの書き方など）。サーバーを読んで op を埋める処理は、アダプターの `prepareDdl` に書く（ルートは呼ぶだけ）。`bun run check:dialect-leaks` が、アダプターの外で尋ねる場所が増えると fail する（基準線は下がるだけ）
- エラーは `lib/errors.ts` で `{ code, message, detail }` に正規化する。コードと HTTP ステータスの対応表は `lib/errors.ts` の `STATUS_BY_CODE` が唯一の正（`AUTH_FAILED` 401、`CONNECTION_FAILED` 502、`KEY_MISMATCH` 409、セッションストアが使えないときの `STORE_UNAVAILABLE` 503 など）。コードを追加するときは `packages/shared` の `ApiErrorCodeSchema` と `STATUS_BY_CODE` を同時に更新する（型が網羅性を強制する）
- セッション: Cookie には署名付き ID のみ。資格情報は `session/store.ts`（メモリ、TTL）と `session/sqlite-store.ts`（`SESSION_SECRET` 由来の鍵で暗号化。本番の既定）にだけ置き、レスポンスに `password` を含めない
- DDL は `/ddl/preview` で SQL を返すだけ。実行は `/sql` を通す（ユーザーがプレビューを確認してから）。アカウント操作だけは例外で、`/users/execute` が `op` から SQL を組み立て直す（プレビューではパスワードをマスクしており、そのまま送り返せる文がないため）。レプリケーションのソース設定（`/server/replication/execute`）も同じ理由で `op` から組み立て直す（レプリケーション用のパスワードを含むため）
- スナップショットの復元（`/databases/:db/snapshots/:id/restore`）も、プレビューと実行を分ける例外（`/users/execute` と同じく、実行する SQL をブラウザから受け取らない）。ダンプは API のメモリが持っており（大きすぎてブラウザとの往復に載せられない。取ってから 24 時間で消える。合計は全アカウントで共有なので、期限がないと戻らないアカウントの分が枠を埋め続け、誰にも消せなくなる）、プレビュー（`…/restore/preview`）は「何を削除し、いくつの文を実行するか」を返し、実行はサーバーが持つダンプを流す。スナップショットはアカウント（ユーザー・ホスト・ポート）× データベース × スキーマごとに分け、ほかのアカウントには見せない
- **保存項目の同時書き込みは CAS（compare-and-set）を通す。** `session/*-store.ts` のように「読む→変更する→書く」で状態を更新するストアは、`get()` が返す `version` を捨てずに `set()` へ引き継ぎ、競合（`false` 返却）は 409 か再試行にする。`version` を分割代入で明示的に捨ててから書く実装は「盲目上書き」になり、同時書き込みで一方が消える（second-factor.ts で3世代にわたって発生・修正済み）。**「null（全消去）に相当する分岐だけ `clear()` のような別の非 CAS 経路に逃げる」のが典型的な抜け穴**なので、CAS化のレビューでは削除・全消去の分岐を必ず個別に確認する
- **2 要素認証の「証明」（コード・回復用コード・パスキーの答え）を受け付ける経路は、必ず `routes/second-factor.ts` の `attempt()` を通す。** 失敗回数（`session/second-factor-lock.ts`）を、証明を**見る前に** CAS で書くことで、同時に投げられても見てもらえる推測が上限（10 回・15 分）を超えない。「見てから、まちがっていたら数える」にすると、並列の総当たりが全部検証される。ロック中は `{ locked }` を返し、呼び出し側は 429 にする（`requireProof` / ログインの `checkLoginFactor`）
- 保存項目（保存済みクエリ・テンプレート・central columns 等）の一意キーは常に `identity（アカウント）× kind × name`（またはそれに準ずる組）で比較する。`name` だけで dedupe・削除・上書きしない。別データベース/別スキーマの同名項目を誤って触る事故はここが原因になる
