# 運用ガイド

## ヘルスチェック

| パス | 意味 | 失敗時 |
|---|---|---|
| `GET /healthz` | プロセスが応答している（liveness） | 再起動 |
| `GET /readyz` | セッションストアが利用可能（readiness） | トラフィックを外す。`readyz.failed` ログを確認 |

## ログ

本番既定は 1 行 1 JSON（`LOG_FORMAT=json`）。主なイベント:

| `event` | 内容 |
|---|---|
| `startup` / `shutdown` | 起動設定（ポート、許可ホスト、TTL）/ 終了シグナル |
| `http` | アクセスログ: `requestId`, `method`, `path`, `status`, `ms`, `ip` |
| `login.ok` / `login.failed` / `login.host_not_allowed` / `login.rate_limited` / `logout` | 認証イベント（ホスト・ユーザー名は含む、パスワードは含まない） |
| `audit` | **監査ログ**: データ・構造・アカウント・サーバー状態を変える呼び出し（`insertRow(s)` / `updateRow` / `deleteRows` / `executeSql` / `killProcess`）。`requestId`, `dbUser`, `dbHost`, `database`, `table`, 行数・キー種別・カラム名、`executeSql` は SQL 先頭 500 文字と文数 / エラー数、`ok`, `ms`。**値は記録しない**。アカウント操作のパスワードは `****` に置換 |
| `readyz.failed` | セッションストア異常 |
| `config.dev_secret` / `web.dist_missing` | 設定の警告 |

`audit` は DDL（`/sql` 経由）やインポート（`executeSql` / `insertRows`）も含みます。SQL コンソールで実行した文の全文が必要な場合は、ログの `sql` は 500 文字で切り詰められている点に注意してください（値を含み得るため意図的に短くしています）。

すべてのレスポンスに `X-Request-Id` が付きます。利用者からの問い合わせにはこの ID で `http` ログを引いてください。

## よくある事象

| 症状 | 原因と対処 |
|---|---|
| 起動直後に `Invalid environment` で終了 | 環境変数の型 / 必須違反。メッセージの変数名を修正 |
| 本番でログインしても直後に未ログイン扱い | `NODE_ENV=production` は `Secure` Cookie。HTTPS で終端し `X-Forwarded-Proto` を渡す |
| ログインが 403 `FORBIDDEN` | 接続先が `TSMYADMIN_ALLOWED_HOSTS` にない |
| ログインが 429 | レート制限。`Retry-After` 秒後に再試行。誤検知なら `TRUST_PROXY` の設定を確認（プロキシ配下で `0` だと全員が同じ IP になる） |
| 再起動後に全員ログアウト | 仕様（セッションはプロセス内）。`docs/deployment.md` のアップグレード節 |
| SQL コンソールでタイムアウト | 既定 30 秒。エディタの「最大行数」と合わせて調整。長時間の一括処理はインポート（最大 10 分）を使う |
| インポートが 413 | 64 MB 上限。分割するか、リバースプロキシの `client_max_body_size` も確認 |
| プロセス一覧で「強制終了」しても消えない | DB 側の権限不足（MySQL は `PROCESS`/`SUPER`、PostgreSQL は `pg_signal_backend` 相当が必要） |

## 監視の目安

- `http` ログの `status >= 500` 率、`ms` の p95
- `login.failed` / `login.rate_limited` の急増（総当たりの兆候）
- `readyz` の失敗

## バックアップ

tsmyadmin 自体に永続データはありません。バックアップ対象は接続先 DB のみです。エクスポート機能は運用バックアップの代替ではありません（一貫スナップショットではありません）。
