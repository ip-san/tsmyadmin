# セキュリティモデル

## 前提

- tsmyadmin は **DB の資格情報を持つ利用者が、その権限の範囲で任意の SQL を実行するためのツール** です。phpMyAdmin と同じく、アプリ側で SQL を制限することは目的ではありません。守るのは「資格情報を持たない者が使えないこと」「意図しない接続先へ踏み台にされないこと」「値がロスレスかつ安全に往復すること」です
- 到達性はネットワーク側で絞ってください（VPN / 社内ネットワーク / IP 制限 / SSO プロキシ）。インターネットに直接公開する用途は想定していません

## 認証とセッション

- 資格情報はサーバー側にだけ保持され、ブラウザには **署名付きセッション ID の Cookie**（`HttpOnly`, `SameSite=Strict`, 本番では `Secure`）しか渡りません。本番既定の `SESSION_STORE=sqlite` では、資格情報は `SESSION_SECRET` から HKDF で導出した鍵による AES-256-GCM で暗号化して保存します（ファイルだけ持ち出されても復号できません。`SESSION_SECRET` は環境変数として厳重に管理してください）
- セッションは無操作 `SESSION_TTL_MINUTES` で失効し、ログアウト / 失効時に DB 接続プールを閉じます
- パスワードは API のレスポンス（`GET /api/session`）、ログ、アカウント操作のプレビュー / 実行結果、DB エラーメッセージのいずれにも含めません（マスク `****`）。SQL コンソールに直接入力した `IDENTIFIED BY '…'` / `PASSWORD '…'` / `SET PASSWORD … = '…'` も監査ログに書く前にマスクします（この正規表現に合わない独自構文は対象外です）
- 想定外の内部エラーはクライアントに `INTERNAL` とだけ返し、メッセージやスタックはサーバーログにのみ残します
- リクエスト本文の上限: `/api/session` 64 KB、SQL 実行 16 MB、インポート `IMPORT_MAX_BYTES`（64 MB）、その他の JSON 1 MB。超過は `413`

## 接続先の制限（SSRF / 踏み台対策）

ログイン画面で指定できる DB ホストは `TSMYADMIN_ALLOWED_HOSTS` に列挙したものだけです。既定はローカルのみ。`*` は開発用途でのみ使ってください。不許可のホスト / ポートへの接続は DB に触れる前に `403 FORBIDDEN` で拒否され、`login.host_not_allowed` として記録されます。

エントリは `host[:port]` です（`db.internal:5432`、`[::1]:3306`、`*.rds.amazonaws.com:5432`）。**本番ではポートまで指定してください**: ポートを省略したエントリはそのホストの全ポートを許可するため、未認証のログイン要求が「接続できた / 認証に失敗した」の違いから、許可ホスト上で待ち受けている他サービスを探るポートスキャンの踏み台になり得ます。起動時にポート省略のエントリがあると `config.allowlist_without_port` を警告します。接続先プリセット（`TSMYADMIN_SERVERS`）はそのプリセットの `host:port` だけを自動で許可します。

## ブルートフォース対策

`POST /api/session` はクライアント IP（ソケットのアドレス。`TRUST_PROXY=1` のときだけ `X-Forwarded-For` の**末尾**（信頼するプロキシが追記した要素。先頭はクライアントが自由に書けます）を採用し、`X-Real-IP` 等のヘッダは信用しない）+ ユーザー名ごとに `LOGIN_RATE_LIMIT` 回 / `LOGIN_RATE_WINDOW_SECONDS` 秒に制限され、超過は `429 RATE_LIMITED`（`Retry-After` 付き）になります。成功時にカウンタはリセットされます。加えてユーザー名を変えながらの試行を防ぐため、IP 単位でも **失敗** `LOGIN_RATE_LIMIT × 3` 回 / 同じウィンドウで制限します（成功したログインは数えないので、共有 NAT 配下の正常な利用者を締め出しません）。

セッション Cookie の `Max-Age` は認証済みリクエストのたびに再発行され、サーバー側のスライド式 TTL と同期します。

## 接続数の上限（DB 側の `max_connections` 保護）

ログインごとにセッション（= 接続プール）が作られるため、同じ DB アカウントで保持するセッションは `SESSION_MAX_PER_IDENTITY`（既定 10）までとし、超えた分は最も古いセッションから閉じます。ログアウトせずに再ログインしたブラウザの以前のセッションも閉じます。DB 側の同時接続上限は「アカウント数 × `SESSION_MAX_PER_IDENTITY` × 4」を超えないことが目安です。

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

- セッションストアは SQLite ファイルのため、複数レプリカで共有できません（スティッキーセッションが必要）
- MySQL の `DELIMITER`（クライアント側コマンド）は解釈しません
- DB 側のユーザー権限が唯一のアクセス制御です。tsmyadmin に独自のロールはありません。権限不足は `PERMISSION_DENIED`（403）として区別して表示します（`docs/operations.md` 参照）
