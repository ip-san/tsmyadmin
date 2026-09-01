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

### ログの保管とローテーション

tsmyadmin はログを **標準出力にのみ** 書き、ファイルへの書き込みやローテーションは行いません（12-factor 方式）。保管はコンテナ / プロセス基盤側で行ってください。

| 環境 | 推奨設定 |
|---|---|
| Docker 単体 | `--log-driver json-file --log-opt max-size=50m --log-opt max-file=10`（compose では `logging:` セクション）。`audit` イベントを長期保管するなら `--log-driver` を `journald` / `fluentd` / `awslogs` などに |
| Kubernetes | 標準の stdout 収集（Fluent Bit / Vector 等）。`event: audit` のみを別インデックスへルーティングすると監査照会が楽になる |
| systemd（直接起動） | journald に入るため `journalctl -u tsmyadmin -o cat \| jq 'select(.event=="audit")'` で抽出。`SystemMaxUse=` で容量を制御 |

監査ログの保持期間は組織のポリシーに合わせてください。1 行あたり数百バイト、変更操作 1 回につき 1 行なので、日に 1 万操作でも数 MB です。

`audit` 行の抽出例:

```bash
docker logs tsmyadmin 2>&1 | jq -c 'select(.event=="audit") | {time, dbUser, action, database, table, ok}'
```

すべてのレスポンスに `X-Request-Id` が付きます。利用者からの問い合わせにはこの ID で `http` ログを引いてください。

## よくある事象

| 症状 | 原因と対処 |
|---|---|
| 起動直後に `Invalid environment` で終了 | 環境変数の型 / 必須違反。メッセージの変数名を修正 |
| 本番でログインしても直後に未ログイン扱い | `NODE_ENV=production` は `Secure` Cookie。HTTPS で終端し `X-Forwarded-Proto` を渡す |
| ログインが 403 `FORBIDDEN` | 接続先が `TSMYADMIN_ALLOWED_HOSTS` にない |
| ログインが 429 | レート制限。`Retry-After` 秒後に再試行。誤検知なら `TRUST_PROXY` の設定を確認（プロキシ配下で `0` だと全員が同じ IP になる） |
| 再起動後に全員ログアウト | `SESSION_STORE=memory`、またはボリューム未設定 / `SESSION_SECRET` 変更。`docs/deployment.md` のアップグレード節 |
| `/readyz` が 503 | SQLite ファイルの権限 / ディスクフル。`readyz.failed` の `error` を確認。`/app/data` は `bun` ユーザーが書ける必要がある |
| SQL コンソールでタイムアウト | 既定 30 秒。実行中は「キャンセル」で中断できる（`KILL QUERY` / `pg_cancel_backend`、監査ログ `cancelQuery`）。長時間の一括処理はインポート（最大 10 分）を使う |
| インポートが 413 | 64 MB 上限。分割するか、リバースプロキシの `client_max_body_size` も確認 |
| プロセス一覧で「強制終了」しても消えない | DB 側の権限不足（MySQL は `PROCESS`/`SUPER`、PostgreSQL は `pg_signal_backend` 相当が必要） |

## エクスポートの完全性

ダンプはストリーミングで送られます。途中で DB 接続が失敗した場合は転送を **中断**（ブラウザでは「失敗」扱い）し、完了したように見える不完全なファイルは残しません。SQL 形式は末尾に `-- tsmyadmin dump complete (N tables)` が付くので、この行があるかどうかで完全性を確認できます（JSON は途中で切れると構文的に無効、CSV は行数で確認）。

## 性能の目安（参考値）

ローカル Docker（MySQL 8.4 / PostgreSQL 17）、20 万行・4 カラムのテーブルでの実測。API プロセスの RSS は約 90 MB のまま変化しません。

| 操作 | PostgreSQL | MySQL |
|---|---|---|
| 表示 1 ページ（絞り込みなし、概算件数） | 0.02 s | 0.03 s |
| 表示 1 ページ（絞り込みあり、正確な件数） | 0.04 s | 0.04 s |
| 表示（OFFSET 190,000） | 0.03 s | 0.03 s |
| SQL コンソール 10,000 行 | 0.11 s | 0.06 s |
| SQL コンソール（複数文） | 各文の完了ごとに結果を送信（NDJSON） | 同左 |
| エクスポート SQL（20 万行、約 10 MB） | 1.9 s | 3.1 s |
| エクスポート CSV / JSON（20 万行） | 1.8 s | 2.9 s |
| サイドバー（1 スキーマに 1,500 テーブル） | 描画は可視行のみ（DOM 上 120 行未満）、絞り込みは件数付きで即時 | 同左 |

## 権限の少ないユーザー

読み取り専用アカウント（`SELECT` のみ）でも閲覧・構造・SQL（SELECT）・エクスポートは動作します。変更操作は DB 側で拒否され、画面には `PERMISSION_DENIED`（403）として「必要な権限がありません」と表示されます。MySQL の「ユーザー」タブは `mysql.user` を読める権限（`SELECT ON mysql.*` または `CREATE USER`）が必要で、無い場合はその旨を表示します。PostgreSQL の「ユーザー」タブは `pg_roles` を参照するため誰でも閲覧できます。

## 監視の目安

- `http` ログの `status >= 500` 率、`ms` の p95
- `login.failed` / `login.rate_limited` の急増（総当たりの兆候）
- `readyz` の失敗

## バックアップ

tsmyadmin の永続データはセッションストア（`data/sessions.sqlite`）だけで、失っても再ログインで済むためバックアップ不要です。バックアップ対象は接続先 DB のみです。エクスポート機能は運用バックアップの代替ではありません（一貫スナップショットではありません）。
