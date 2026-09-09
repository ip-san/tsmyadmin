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
| `startup` / `shutdown.begin` / `shutdown.done` / `shutdown.timeout` / `shutdown.forced` | 起動設定（ポート、許可ホスト、TTL）/ グレースフルシャットダウンの開始・完了・上限超過・2 回目のシグナルによる強制終了（1 秒以内の重複シグナルは無視） |
| `http` | アクセスログ: `requestId`, `method`, `path`, `status`, `ms`, `ip`。成功した `/healthz` `/readyz`（プローブ）と `/assets/*`（ハッシュ付き静的ファイル、ブラウザが 1 年キャッシュ）は記録しない。ログレベルの設定はなく、`warn` / `error` の抽出はログ収集側で行う |
| `login.ok` / `login.failed` / `login.host_not_allowed` / `login.insecure_transport` / `login.rate_limited` / `logout` | 認証イベント（ホスト・ユーザー名・セッション ID のハッシュ先頭 16 桁は含む、パスワードと生のセッション ID は含まない） |
| `audit` | **監査ログ**: データ・構造・アカウント・サーバー状態を変える呼び出し（`insertRow(s)` / `updateRow` / `deleteRows` / `executeSql` / `cancelQuery` / `killProcess`）。`requestId`, `dialect`, `dbUser`, `dbHost`, `database`, `schema`, `table`, 行数・キー種別・カラム名、`executeSql` は SQL 先頭 500 文字と文数 / エラー数、`ok`, `ms`。失敗時は `error`（エラーコード）と `nativeCode` だけで、サーバーのメッセージは記録しない。**行の値は記録しない**（SQL コンソールの文は先頭 500 文字を記録するため値を含み得る。インポートは `<import>` と文字数だけを記録し、ファイルの中身は一切残さない）。パスワード（アカウント操作、SQL コンソールの `IDENTIFIED BY` / `PASSWORD` 文）は `****` に置換 |
| `readyz.failed` | セッションストア異常（`error` レベル） |
| `unhandled` | 想定外の例外（`error` レベル）。`requestId` とスタックを含み、レスポンスは `500 INTERNAL`。`X-Request-Id` から引ける |
| `export.aborted` | エクスポートのストリーミングが途中で失敗（`error` レベル）。ダウンロード済みのファイルは不完全 |
| `session_store.open_failed` / `session_store.reset` | SQLite セッションストアを開けず終了（`path`, `error`, `hint`）/ `SESSION_SECRET` 変更を検出して保存済みセッションを削除 |
| `config.dev_secret` / `config.allowlist_without_port` / `config.cookie_insecure` / `web.dist_missing` | 設定の警告（開発用シークレット / ポート未指定の許可ホスト / 本番で `COOKIE_SECURE=0` / SPA ビルド不在） |

`audit` は DDL（`/sql` 経由）やインポート（`executeSql` / `insertRows`）も含みます。SQL コンソールで実行した文の全文が必要な場合は、ログの `sql` は 500 文字で切り詰められている点に注意してください（値を含み得るため意図的に短くしています）。パスワードの検出は先頭 8,000 文字までを走査します（64 MB のスクリプトに正規表現をかけるとイベントループが止まるため）。

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
| ログインが 400 `INSECURE_TRANSPORT`（画面は「HTTPS で接続してください（HTTP ではログイン状態を保持できません）」、ログは `login.insecure_transport`） | Cookie が `Secure`（`NODE_ENV=production`）なのに平文 HTTP で届いている。HTTPS で終端し、プロキシが `X-Forwarded-Proto: https` を付けて `TRUST_PROXY=1` にする。TLS を終端しない社内ネットワークでは `COOKIE_SECURE=0` |
| ログインが 403 `HOST_NOT_ALLOWED` | 接続先が `TSMYADMIN_ALLOWED_HOSTS` にない（画面には「この接続先は管理者により許可されていません」） |
| ログインが 429 | レート制限。`Retry-After` 秒後に再試行。誤検知なら `TRUST_PROXY` の設定を確認（プロキシ配下で `0` だと全員が同じ IP になる） |
| 再起動後に全員ログアウト | `SESSION_STORE=memory`、またはボリューム未設定 / `SESSION_SECRET` 変更。`docs/deployment.md` のアップグレード節 |
| 起動直後に `session_store.open_failed` で終了（コンテナが再起動ループ） | `SESSION_DB_PATH`（Docker では `/app/data`）に `bun` ユーザー（uid 1000）の書き込み権限がない。バインドマウントは `chown 1000:1000`。`unable to open database file` / `attempt to write a readonly database` が `error` に出る |
| `/readyz` が 503 | 起動後に SQLite ファイルが読めなくなった / 破損。`readyz.failed` の `error` を確認 |
| SQL コンソールでタイムアウト | 既定 30 秒。実行中は「キャンセル」で中断できる（`KILL QUERY` / `pg_cancel_backend`、監査ログ `cancelQuery`）。長時間の一括処理はインポート（最大 10 分）を使う |
| インポートが 413 `PAYLOAD_TOO_LARGE`（ファイルが 64 MB 超 / 本文が 65 MB 超） | 分割するか、リバースプロキシの `client_max_body_size` も確認 |
| プロセス一覧で「強制終了」しても消えない | DB 側の権限不足（MySQL は `PROCESS`/`SUPER`、PostgreSQL は `pg_signal_backend` 相当が必要） |

### エラーコード早見表

API が返すコードは `apps/api/src/lib/errors.ts` の `STATUS_BY_CODE` が唯一の正です。運用で問い合わせになりやすいものを挙げます。

| コード | HTTP | 意味と対処 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | セッションがない / 失効。画面は自動でログインへ戻ります |
| `AUTH_FAILED` | 401 | DB の資格情報が誤り。接続先の egress アドレスを漏らさないため、詳細は返しません |
| `CONNECTION_FAILED` | 502 | 接続先 DB に到達できない。下の「接続先 DB の再起動・障害」を参照 |
| `HOST_NOT_ALLOWED` | 403 | 接続先が `TSMYADMIN_ALLOWED_HOSTS` にない |
| `INSECURE_TRANSPORT` | 400 | 上記のとおり、`Secure` Cookie を平文 HTTP で発行しようとした |
| `RATE_LIMITED` | 429 | ログインのレート制限。`Retry-After` 秒後に再試行 |
| `FORBIDDEN` | 403 | CSRF 判定（`hono/csrf`）。対象はフォーム形式の POST（インポートのアップロード）と、本文を持たないリクエスト（ログアウトの `DELETE /api/session`）だけで、JSON の API には効きません。`Sec-Fetch-Site: same-origin` を送る現行ブラウザはそのまま通ります。このヘッダーを落とすプロキシや古いブラウザでは `Origin` とホストを比較するため、リバースプロキシが `Host` を書き換えていると 403 になります（nginx は `proxy_set_header Host $host`） |
| `PAYLOAD_TOO_LARGE` | 413 | 本文 / アップロードが上限超過。上限は [deployment.md](deployment.md) の「サイズと制限」 |
| `PERMISSION_DENIED` | 403 | DB ユーザーの権限不足。メッセージに必要な権限名が入ります |
| `KEY_MISMATCH` | 409 | 更新しようとした行が他の誰かに変更された（1 行に一致しなかったのでロールバック）。画面を再読み込みしてやり直す |
| `QUERY_FAILED` | 400 | SQL のエラー。`nativeCode`（MySQL の `ER_*` / PostgreSQL の SQLSTATE）が付きます。SQL コンソールの既定タイムアウト 30 秒の超過もここ |
| `UNSUPPORTED` | 400 | その方言・サーバーで扱えない操作（psql メタコマンド、TiDB のルーチンなど） |
| `INTERNAL` | 500 | 想定外の例外。`X-Request-Id` でログの `unhandled` を引く |

## 接続先 DB の再起動・障害

接続先の DB が落ちている間、その DB を使う API は **即座に** `502 CONNECTION_FAILED` を返します（待ち続けません。画面には「データベースに接続できません」と再試行ボタン）。tsmyadmin 側のプロセスは落ちず、`/healthz` と `/readyz` は 200 のままです（これらは tsmyadmin 自身とセッションストアの健全性を示すもので、接続先 DB の状態ではありません）。

DB が復帰すると、**同じログインセッションのまま**次のリクエストから成功します（プールが張り直されます。再ログインは不要）。実測（`docker restart`）: MySQL 8.4 は約 9 秒後、PostgreSQL 17 は約 1 秒後に復帰し、その間のリクエストはすべて 502、`error` レベルのログは出ません。

- 実行中だったクエリはサーバー側で失われるため、その文はエラーとして結果に出ます（インポートで「1 つのトランザクションで実行する」を選んでいれば、そのファイルは何も反映されません）
- ロードバランサのヘルスチェックに接続先 DB の状態を含めたい場合は、`/readyz` ではなく監視側から `GET /api/databases`（要ログイン）などを使ってください

## エクスポートの完全性

ダンプはストリーミングで送られます。途中で DB 接続が失敗した場合は転送を **中断**（ブラウザでは「失敗」扱い）し、完了したように見える不完全なファイルは残しません。SQL 形式は末尾に `-- tsmyadmin dump complete (N objects)` が付くので、この行があるかどうかで完全性を確認できます（JSON は途中で切れると構文的に無効、CSV は行数で確認）。

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

読み取り専用アカウント（`SELECT` のみ）でも閲覧・構造・SQL（SELECT）・エクスポートは動作します。変更操作は DB 側で拒否され、画面には `PERMISSION_DENIED`（403）として「この操作に必要な権限が DB ユーザーにありません」と表示されます。MySQL の「ユーザー」タブは `mysql.user` を読める権限（`SELECT ON mysql.*` または `CREATE USER`）が必要で、無い場合はその旨を表示します。PostgreSQL の「ユーザー」タブは `pg_roles` を参照するため誰でも閲覧できます。

## 監視の目安

- `http` ログの `status >= 500` 率、`ms` の p95
- `login.failed` / `login.rate_limited` の急増（総当たりの兆候）
- `error` レベルの件数（`unhandled` / `export.aborted` / `readyz.failed` / `session_store.open_failed`）
- `readyz` の失敗

## バックアップ

tsmyadmin の永続データはセッションストア（`data/sessions.sqlite`）だけで、失っても再ログインで済むためバックアップ不要です。バックアップ対象は接続先 DB のみです。エクスポート機能は運用バックアップの代替ではありません（一貫スナップショットではありません）。
