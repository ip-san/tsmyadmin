# デプロイガイド

tsmyadmin は **1 プロセス（Bun）で API と SPA を配信する単一コンテナ** として動きます。データベースは接続先として外部にあり、tsmyadmin が持つ永続データはセッションストア（`/app/data/sessions.sqlite`、暗号化済み）だけです。

## 環境変数（唯一の一覧）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` で Cookie に `Secure`、ログ JSON、`SESSION_SECRET` 必須 |
| `API_PORT` | `3100` | 待ち受けポート（1–65535。Docker イメージの `HEALTHCHECK` は 3100 固定） |
| `SESSION_SECRET` | （開発用固定値） | セッション Cookie の署名鍵。**本番では 32 文字以上必須**。`openssl rand -hex 32` |
| `SESSION_TTL_MINUTES` | `30` | 操作ごとに延長されるセッション寿命（1–1440） |
| `SESSION_MAX_PER_IDENTITY` | `10`（1–1000） | 同じ DB アカウント（種別 / ホスト / ポート / ユーザー名）で同時に保持するセッション数。超えると最も古いものを閉じる（ログインの繰り返しで DB の `max_connections` を使い切らせない） |
| `SESSION_STORE` | 本番 `sqlite` / 開発 `memory` | `sqlite` は再起動・ローリング更新後もセッションを維持（資格情報は `SESSION_SECRET` から導出した鍵で AES-256-GCM 暗号化して保存）。`memory` はプロセス内のみ |
| `SESSION_DB_PATH` | `data/sessions.sqlite` | `sqlite` 時のファイル。Docker では `/app/data` をボリュームにする |
| `TSMYADMIN_ALLOWED_HOSTS` | `127.0.0.1,localhost` | ログイン画面から接続を許可する DB ホスト。カンマ区切りで、完全一致 / `*.suffix` / `*`（無制限）、それぞれ `:port` 付き可（`db.internal:5432`、`[::1]:3306`）。ポート省略は全ポート許可 — **本番ではポートまで指定する**（`docs/security.md`）。**SSRF・踏み台防止の要** |
| `TSMYADMIN_SERVERS` | （なし） | ログイン画面に出す接続先プリセットの JSON 配列。例: `[{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}]`。利用者はユーザー名とパスワードだけを入力。プリセットのホストは自動的に allowlist に加わる。**パスワードは書かない** |
| `LOGIN_RATE_LIMIT` | `10` | `LOGIN_RATE_WINDOW_SECONDS` 内に許可するログイン試行回数（クライアント IP + ユーザー名ごと。IP 単位では 3 倍まで） |
| `LOGIN_RATE_WINDOW_SECONDS` | `60` | 上記のウィンドウ（秒、1 以上。`LOGIN_RATE_LIMIT` も 1 以上） |
| `TRUST_PROXY` | `0` | `1` でリバースプロキシの `X-Forwarded-For` をクライアント IP として信頼する（プロキシ配下では必須、直接公開時は `0` のまま） |
| `LOG_FORMAT` | 本番 `json` / 開発 `pretty` | 1 行 1 JSON（ログ収集向け）か人が読む形式か |
| `WEB_DIST` | `apps/web/dist` | 配信する SPA ビルドのディレクトリ（作業ディレクトリからの相対） |
| `SHUTDOWN_TIMEOUT_SECONDS` | `30`（0–600） | `SIGTERM` 受信後、実行中のリクエスト（長い SQL・エクスポート・インポート）の完了を待つ上限。超過すると強制終了 |

起動時に検証され、範囲外・不正な値があれば理由を表示して終了します（`Invalid environment: ...`）。

開発 / テスト専用の変数（本番では無視）: `WEB_PORT`（Vite 開発サーバー、既定 5175）、`TEST_MYSQL_URL` / `TEST_PG_URL`（統合テストと E2E が接続する compose の DB）。

## Docker

```bash
docker build -t tsmyadmin .
docker build --build-arg VERSION="$(node -p "require('./package.json').version")" -t tsmyadmin .
docker run -d --name tsmyadmin \
  -p 127.0.0.1:3100:3100 \
  --stop-timeout 35 \
  -e NODE_ENV=production \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e TSMYADMIN_ALLOWED_HOSTS= \
  -e TSMYADMIN_SERVERS='[{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}]' \
  -e TRUST_PROXY=1 \
  -v tsmyadmin-data:/app/data \
  tsmyadmin
```

- `TSMYADMIN_ALLOWED_HOSTS=`（空文字）を明示すると既定の `127.0.0.1,localhost`（コンテナ自身のループバック。本番では不要で、ポート未指定の警告も出る）が外れ、プリセットの `host:port` だけが許可されます。プリセットを使わない場合は `host:port` を列挙してください
- イメージは非 root ユーザー `bun`（uid/gid 1000）で動作し、本番依存のみを含みます。`HEALTHCHECK` は `/readyz` を見ます（ポート 3100 固定。コンテナ内のポートは変えず、ホスト側の `-p` で対応してください）
- `/app/data` にセッションストアが置かれます。ボリュームを付けないと再起動で全員ログアウトになります（機能は損なわれません）。バインドマウントの場合は `chown 1000:1000 <dir>` が必要です
- `/healthz`（生存）と `/readyz`（セッションストアの疎通）を公開します。オーケストレータのプローブに使ってください
- `--stop-timeout`（compose では `stop_grace_period`）は Docker 既定の 10 秒では `SHUTDOWN_TIMEOUT_SECONDS`（30 秒）より短く、実行中のエクスポート / インポートが SIGKILL で切られます。`SHUTDOWN_TIMEOUT_SECONDS + 5` 秒以上にしてください
- 目安のリソース: 1 vCPU / メモリ 512 MB。アイドル時は約 90 MB、64 MB のインポートや主キーのない MySQL テーブルの大きなエクスポートではピークが数百 MB になります。`--memory` を 256 MB 未満にしないでください

### docker compose の例

```yaml
services:
  tsmyadmin:
    image: tsmyadmin:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      SESSION_SECRET: ${SESSION_SECRET:?set in .env}
      TSMYADMIN_ALLOWED_HOSTS: db:5432
      TRUST_PROXY: "1"
    ports:
      - "127.0.0.1:3100:3100"
    stop_grace_period: 35s
    volumes:
      - tsmyadmin-data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "10"
volumes:
  tsmyadmin-data:
```

イメージに `HEALTHCHECK`（`/readyz`）が組み込まれているため、compose 側で上書きする必要はありません。上書きする場合、実行イメージ（`oven/bun:1.4-slim`）には `curl` / `wget` がないので `["CMD", "bun", "-e", "fetch('http://127.0.0.1:3100/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]` を使ってください。

## リバースプロキシと TLS

tsmyadmin 自身は TLS を終端しません。**必ず HTTPS を終端するリバースプロキシの背後に置いてください**（`NODE_ENV=production` では Cookie に `Secure` が付くため、平文 HTTP ではログインできません）。

nginx の例:

```nginx
server {
  listen 443 ssl http2;
  server_name admin.example.com;
  # ssl_certificate ...;

  # 社内ネットワーク / VPN / SSO プロキシなどで到達性を絞ることを強く推奨
  allow 10.0.0.0/8;
  deny all;

  client_max_body_size 70m;   # インポート上限 64MB + マルチパート余裕

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;   # 長い SQL / インポート
  }
}
```

`TRUST_PROXY=1` を設定すると、レート制限とアクセスログが `X-Forwarded-For` の**末尾**のアドレス（直前のプロキシが追記した値）をクライアント IP として使います。`$proxy_add_x_forwarded_for` のように追記するプロキシでも、クライアントが先頭に偽の値を書いても影響しません。プロキシが多段の場合は、tsmyadmin の直前のプロキシが自分の見たアドレスを末尾に追記する設定にしてください（末尾は常に「直前のホップが見たアドレス」= 多段では手前のプロキシの IP になるため、その場合は手前のプロキシで正規化してください）。プロキシを介さず直接公開する場合は `0` のままにしてください（ヘッダ偽装でレート制限を回避されます）。

## サイズと制限

| 項目 | 値 | 場所 |
|---|---|---|
| ブラウズ 1 ページ | 最大 1,000 行。絞り込みなしで概算 100,000 行を超えるテーブルは `COUNT(*)` を避けてカタログの概算件数を表示（「約 N 件（概算）」） | `BROWSE_MAX_LIMIT`, `EXACT_COUNT_MAX_ROWS` |
| SQL コンソール結果 | 既定 1,000 / 最大 10,000 行、既定タイムアウト 30 秒 | `SQL_MAX_ROWS_*`, `SQL_TIMEOUT_DEFAULT_MS` |
| インポートファイル | 64 MB | `IMPORT_MAX_BYTES` |
| エクスポート | ストリーミング（500 行ずつ読み出して逐次送信）。例外: 主キーも一意キーもない MySQL テーブルは安定した順序が取れないため 1 回で全件読み出す（巨大な無 PK テーブルはメモリを消費） | `apps/api/src/lib/export.ts`, `iterateRows` |
| バイナリ値の表示 | 先頭 64 KB | `MAX_BINARY_BYTES` |
| DB 接続プール | ログインセッションごとに最大 4 接続（PostgreSQL は接続先データベースごとに 1 プール）。60 秒アイドルで接続を閉じ、セッション失効（`SESSION_TTL_MINUTES`）でプールごと破棄。DB 側の同時接続上限は「想定同時ログイン数 × 4」を目安に確保する | adapter (`idleTimeout`) |

## 停止と再起動（グレースフルシャットダウン）

`SIGTERM` / `SIGINT` を受けると新規接続の受付を止め、実行中のリクエストが終わるのを `SHUTDOWN_TIMEOUT_SECONDS`（既定 30 秒）まで待ってから各セッションの DB 接続プールを閉じて終了します。2 回目のシグナルか上限超過で即時終了します。

- Kubernetes では `terminationGracePeriodSeconds` を `SHUTDOWN_TIMEOUT_SECONDS + 5` 以上にしてください
- `/readyz` はリスナーが閉じるまで 200 を返します。ローリング更新ではロードバランサから外してから `SIGTERM` を送る（`preStop` で数秒待つ）と、停止中のインスタンスに新規リクエストが振られません

## アップグレード

イメージを差し替えて再起動するだけです。`SESSION_STORE=sqlite`（本番既定）でボリュームを維持していれば利用者のセッションは継続します。`SESSION_SECRET` を変えると保存済みセッションは復号できず破棄されます（全員再ログイン）。スキーマや設定ファイルのマイグレーションはありません。

複数レプリカで動かす場合は同じ SQLite ファイルを共有できないため、ロードバランサをスティッキーセッションにし、**かつ**レプリカごとに別ボリュームを持たせてください（片方だけでは、別レプリカに振られた瞬間にログアウトになります）。

ロールバックも同じ手順（イメージを戻して再起動）です。セッション表は `CREATE TABLE IF NOT EXISTS` と列の追加だけで管理しており、旧バージョンが読めない行は破棄されます（該当利用者は再ログイン）。
