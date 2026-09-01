# セキュリティモデル

## 前提

- tsmyadmin は **DB の資格情報を持つ利用者が、その権限の範囲で任意の SQL を実行するためのツール** です。phpMyAdmin と同じく、アプリ側で SQL を制限することは目的ではありません。守るのは「資格情報を持たない者が使えないこと」「意図しない接続先へ踏み台にされないこと」「値がロスレスかつ安全に往復すること」です
- 到達性はネットワーク側で絞ってください（VPN / 社内ネットワーク / IP 制限 / SSO プロキシ）。インターネットに直接公開する用途は想定していません

## 認証とセッション

- 資格情報はサーバープロセスのメモリにだけ保持され、ブラウザには **署名付きセッション ID の Cookie**（`HttpOnly`, `SameSite=Strict`, 本番では `Secure`）しか渡りません
- セッションは無操作 `SESSION_TTL_MINUTES` で失効し、ログアウト / 失効時に DB 接続プールを閉じます
- パスワードは API のレスポンス（`GET /api/session`）、ログ、アカウント操作のプレビュー / 実行結果、DB エラーメッセージのいずれにも含めません（マスク `****`）

## 接続先の制限（SSRF / 踏み台対策）

ログイン画面で指定できる DB ホストは `TSMYADMIN_ALLOWED_HOSTS` に列挙したものだけです。既定はローカルのみ。`*` は開発用途でのみ使ってください。不許可のホストへの接続は DB に触れる前に `403 FORBIDDEN` で拒否され、`login.host_not_allowed` として記録されます。

## ブルートフォース対策

`POST /api/session` はクライアント IP + ユーザー名ごとに `LOGIN_RATE_LIMIT` 回 / `LOGIN_RATE_WINDOW_SECONDS` 秒に制限され、超過は `429 RATE_LIMITED`（`Retry-After` 付き）になります。成功時にカウンタはリセットされます。

## CSRF / XSS

- `SameSite=Strict` Cookie に加え、フォーム（マルチパート）POST は `Origin` 検証（`hono/csrf`）で保護します。JSON API はブラウザのクロスオリジン制約（CORS 未許可）により外部サイトから呼べません
- `Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'none'` など（`apps/api/src/app.ts` の `CONTENT_SECURITY_POLICY`）。インライン script は許可しません。CodeMirror の都合で `style-src 'unsafe-inline'` のみ許可しています
- 値の描画はすべて React 経由（`dangerouslySetInnerHTML` 不使用）

## SQL の組み立て

- 識別子は必ずクォート（`quoteIdent`）、値は必ずプレースホルダ。文字列補間で SQL を組み立てられる場所はアダプター内の限られたビルダーだけで、`bun run check:sql-safety` が CI で強制します
- DDL・アカウント操作は生成 SQL をプレビューし、利用者の明示的な確認後にのみ実行します
- 行の更新 / 削除はトランザクション内で「影響行数 = 1」を検証し、違えばロールバックします

## 監査

構造化ログ（`LOG_FORMAT=json`）に `login.ok` / `login.failed` / `login.host_not_allowed` / `login.rate_limited` / `logout` とリクエスト ID 付きのアクセスログが出ます。変更系の呼び出しはアダプター境界の監査ログ（`event: audit`）に、誰が・どの DB に・何を（値は含まない）・成功したかが記録されます。詳細は `docs/operations.md`。

## 既知の制限

- セッションはプロセス内メモリのため、複数レプリカでのスティッキーでない負荷分散はできません
- MySQL の `DELIMITER`（クライアント側コマンド）は解釈しません
- DB 側のユーザー権限が唯一のアクセス制御です。tsmyadmin に独自のロールはありません
