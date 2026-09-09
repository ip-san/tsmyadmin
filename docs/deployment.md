# デプロイガイド

tsmyadmin は **1 プロセス（Bun）で API と SPA を配信する単一コンテナ** として動きます。データベースは接続先として外部にあり、tsmyadmin が持つ永続データはセッションストア（`/app/data/sessions.sqlite`、暗号化済み）だけです。

## 対応データベース

| 種別 | 対応バージョン | 検証状況 |
|---|---|---|
| MySQL | 8.0 / 8.4 / 9 | 統合テスト全通過（8.0 と 8.4 は CI で毎回） |
| MariaDB | 10.11 (LTS) / 11 | 統合テスト全通過（CI で毎回、両方） |
| Percona Server | 8.4 | 統合テスト全通過（手動検証） |
| PostgreSQL | 14 / 15 / 16 / 17 / 18 | 統合テスト全通過（14 と 17 は CI で毎回） |

- 上記より古いバージョン（MySQL 5.7、PostgreSQL 13 以前、MariaDB 10.6 以前）は検証していません。5.7 は `information_schema` の構成が異なるため動作しない機能があります
- **互換エンジン**は「接続はできるが一部機能が動かない」ことを実測しています。カタログ（`pg_catalog` / `information_schema` / `mysql.user`）に依存する機能ほど差異が出ます。

  | エンジン | 実測結果 | 判定 |
  |---|---|---|
  | TiDB 7.5 | conformance 113 件中 82 件通過。閲覧・SQL 実行（行数上限つき）・DDL・エクスポートは動作。ストアドルーチン / トリガー / イベントはサーバー自体が非対応のため一覧が空またはエラー | 限定動作（非対応） |
  | CockroachDB 24.3 | conformance 113 件中 55 件通過。閲覧と基本的な SQL は動作するが、シーケンス・継承・ctid・ルーチン・トリガーなど PostgreSQL 固有のカタログに依存する機能が広範に失敗 | 非対応 |

- Aurora / Cloud SQL / AlloyDB など、上流と同じエンジンを使うマネージドサービスは未検証ですが、カタログが同一であれば動作する想定です（`SUPER` 権限が必要な操作、`KILL`、`pg_terminate_backend` などはサービス側の制限を受けます）
- 接続には対象サーバーのユーザーが必要です。閲覧のみなら `SELECT` 権限で足り、機能に応じて `SHOW VIEW`・`PROCESS`・`CREATE USER` などが必要になります（`docs/operations.md` の「権限の少ないユーザー」）

## 環境変数（唯一の一覧）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` で Cookie に `Secure`（`COOKIE_SECURE` で上書き可）、ログ JSON、`SESSION_SECRET` 必須 |
| `API_PORT` | `3100` | 待ち受けポート（1–65535）。未指定なら `PORT`（PaaS が注入する変数）を代わりに使う。Docker イメージの `EXPOSE` は 3100 だが `HEALTHCHECK` は実際のポートに従う |
| `COOKIE_SECURE` | 本番 `1` / 開発 `0` | セッション Cookie の `Secure`。`1` のとき平文 HTTP でのログインは `INSECURE_TRANSPORT`（400）で拒否する（ブラウザが Cookie を捨てるため）。TLS を終端しない社内ネットワークでだけ `0` にする。`localhost` / `127.0.0.1` / `::1` への平文アクセスは常に許可（Chrome / Firefox は localhost の Secure Cookie を受け入れる。Safari は受け入れないため、Safari で試す場合も HTTPS か `COOKIE_SECURE=0` が必要） |
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
| `WEB_DIST` | `apps/web/dist` | 配信する SPA ビルドのディレクトリ。省略時は API ソースの位置から解決されるため作業ディレクトリに依存しない。指定する場合は絶対パスか作業ディレクトリからの相対 |
| `SHUTDOWN_TIMEOUT_SECONDS` | `30`（0–600） | `SIGTERM` 受信後、実行中のリクエスト（長い SQL・エクスポート・インポート）の完了を待つ上限。超過すると強制終了 |

起動時に検証され、範囲外・不正な値があれば理由を表示して終了コード 1 で終了します（メッセージは必ず `Invalid environment: ...` で始まります）。空文字（`NAME=`）は未設定として扱われ既定値が使われます。例外は `TSMYADMIN_ALLOWED_HOSTS=` で、これは「既定のローカルホストも許可しない（プリセットの接続先だけ）」の意味です。`TSMYADMIN_SERVERS` のプリセットに未知のキー（`password` など）があると起動時に拒否されます。

開発 / テスト専用の変数（本番では無視）: `WEB_PORT`（Vite 開発サーバー、既定 5175）、`TEST_MYSQL_URL` / `TEST_PG_URL`（統合テストと E2E が接続する compose の DB）。

## Docker

```bash
docker build -t tsmyadmin .
# OCI ラベル（version / revision / created）を埋める場合
docker build \
  --build-arg VERSION="$(node -p "require('./package.json').version")" \
  --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t tsmyadmin .
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
- 目安のリソース: 1 vCPU / メモリ 512 MB。アイドル時は約 90 MB、64 MB のインポート（ファイル全体をメモリに置く）ではピークが数百 MB になります。エクスポートは 500 行ずつストリーミングし、テーブルの大きさに依存しません。`--memory` を 256 MB 未満にしないでください

### docker compose の例

```yaml
services:
  tsmyadmin:
    image: tsmyadmin:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      SESSION_SECRET: ${SESSION_SECRET:?set in .env}
      # `db` は同じ compose ネットワーク上の DB サービス名の例。外部 DB なら host:port、Docker Desktop のホスト上なら host.docker.internal:5432
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

tsmyadmin 自身は TLS を終端しません。**必ず HTTPS を終端するリバースプロキシの背後に置いてください**（`NODE_ENV=production` では Cookie に `Secure` が付き、平文 HTTP でのログインは `HTTPS で接続してください` と拒否されます。ログには `login.insecure_transport` が出ます。TLS を終端しない社内ネットワークでは `COOKIE_SECURE=0`）。プロキシは `X-Forwarded-Proto` を付け、`TRUST_PROXY=1` にしてください（それがないと HTTPS 経由でも平文と判定されます）。

ルート直下（`https://admin.example.com/`）でのみ動作します。サブパス（`https://example.com/tsmyadmin/`）配下には置けません（アセットと API のパスが `/` 基準のため）。

`Strict-Transport-Security: max-age=15552000; includeSubDomains` を常に返します（`hono/secure-headers` の既定）。apex ドメインで同居する他サービスが HTTP のままの場合は注意してください。

nginx の例:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name admin.example.com;
  # ssl_certificate ...;

  # 社内ネットワーク / VPN / SSO プロキシなどで到達性を絞ることを強く推奨
  allow 10.0.0.0/8;
  deny all;

  client_max_body_size 70m;   # インポート上限 64MB + マルチパート余裕
  # tsmyadmin は SPA を gzip で返します（API は非圧縮 = NDJSON ストリームを文ごとに届けるため）。
  # nginx 側で圧縮する場合は API を除外してください: gzip on; gzip_types text/javascript application/javascript text/css;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;   # API 側の無通信上限（255 秒）以上に。エクスポートは空行のハートビートを送らない
    proxy_buffering off;       # NDJSON の進捗・空行をそのまま流す（バッファすると進捗が止まって見える）
  }
}
```

`TRUST_PROXY=1` を設定すると、レート制限とアクセスログが `X-Forwarded-For` の**末尾**のアドレス（直前のプロキシが追記した値）をクライアント IP として使います。`$proxy_add_x_forwarded_for` のように追記するプロキシでも、クライアントが先頭に偽の値を書いても影響しません。プロキシが多段の場合は、tsmyadmin の直前のプロキシが自分の見たアドレスを末尾に追記する設定にしてください（末尾は常に「直前のホップが見たアドレス」= 多段では手前のプロキシの IP になるため、その場合は手前のプロキシで正規化してください）。プロキシを介さず直接公開する場合は `0` のままにしてください（ヘッダ偽装でレート制限を回避されます）。

## 直接起動（systemd）

Docker を使わない場合は Bun 1.4 以上を入れ、次の順で準備します。

1. `bun install --frozen-lockfile`（ビルドには開発依存が必要）
2. `bun run build`（SPA を `apps/web/dist` に生成）
3. 任意: `bun install --frozen-lockfile --production --ignore-scripts --filter '!@tsmyadmin/web'` で実行時依存だけに絞る（Docker イメージと同じ構成。ビルド済みの `apps/web/dist` はそのまま残る）

起動は `bun apps/api/src/index.ts`。`SESSION_DB_PATH` は作業ディレクトリからの相対なので `WorkingDirectory` を固定し、`data/` を `User=` のユーザーが書き込めるようにしてください。`EnvironmentFile` には少なくとも `NODE_ENV=production`・`SESSION_SECRET`・`TSMYADMIN_ALLOWED_HOSTS` を置きます。

```ini
[Unit]
Description=tsmyadmin
After=network.target

[Service]
User=tsmyadmin
WorkingDirectory=/opt/tsmyadmin
EnvironmentFile=/etc/tsmyadmin.env
ExecStart=/usr/local/bin/bun apps/api/src/index.ts
KillSignal=SIGTERM
TimeoutStopSec=40
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## サイズと制限

| 項目 | 値 | 場所 |
|---|---|---|
| ブラウズ 1 ページ | 最大 1,000 行。絞り込みなしで概算 100,000 行を超えるテーブルは `COUNT(*)` を避けてカタログの概算件数を表示（「約 N 件（概算）」）。絞り込みありの件数は 100,000 行で打ち切り（「100,000 行以上」、最終ページへのジャンプは不可） | `BROWSE_MAX_LIMIT`, `EXACT_COUNT_MAX_ROWS` |
| SQL コンソール結果 | 既定 1,000 / 最大 10,000 行、既定タイムアウト 30 秒 | `SQL_MAX_ROWS_*`, `SQL_TIMEOUT_DEFAULT_MS` |
| インポートファイル | 64 MB | `IMPORT_MAX_BYTES` |
| エクスポート | ストリーミング（500 行ずつ読み出して逐次送信。主キーも一意キーもない MySQL テーブルも 1 本の SELECT を行ストリームで読む） | `apps/api/src/lib/export.ts`, `iterateRows` |
| 長いレスポンスの維持 | SQL 実行・インポートは処理中 15 秒ごとに空行（NDJSON のハートビート）を送る。HTTP 接続のアイドル上限は 255 秒（Bun の上限）で、エクスポートはハートビートを送らないため最初の行を返すまで 255 秒以上かかるクエリ（巨大テーブルの並べ替え）は切断される。リバースプロキシ / ロードバランサのアイドルタイムアウト（nginx `proxy_read_timeout`、ALB idle timeout = 既定 60 秒など）は 255 秒以上、かつプロキシのレスポンスバッファリングは無効（nginx `proxy_buffering off`）にする | `idleTimeout`, `HEARTBEAT_MS` |
| バイナリ値の表示 | 先頭 64 KB | `MAX_BINARY_BYTES` |
| 長いテキストの表示 | 先頭 65,536 文字（「先頭のみ表示」と全体の文字数を併記。超えるセルは画面から編集できず、SQL で更新する。エクスポートは全文） | `MAX_TEXT_CHARS` |
| DB 接続プール | ログインセッションごとに最大 4 接続（PostgreSQL は接続先データベースごとに 1 プール）。60 秒アイドルで接続を閉じ、セッション失効（`SESSION_TTL_MINUTES`）でプールごと破棄。DB 側の同時接続上限（`max_connections`）は「想定同時ログイン数 × 4 + 監視・管理用の余裕 5 程度」を目安に確保する | adapter (`idleTimeout`) |

## 停止と再起動（グレースフルシャットダウン）

`SIGTERM` / `SIGINT` を受けると新規接続の受付を止め、実行中のリクエストが終わるのを `SHUTDOWN_TIMEOUT_SECONDS`（既定 30 秒）まで待ってから各セッションの DB 接続プールを閉じて終了します。2 回目のシグナルか上限超過で即時終了します（1 秒以内に重ねて届いたシグナルは同じ停止要求とみなして無視します。`docker stop` が SIGTERM を二重に送ることがあるため）。

- Kubernetes では `terminationGracePeriodSeconds` を `SHUTDOWN_TIMEOUT_SECONDS + 5` 以上にしてください
- `SIGTERM` を受けた瞬間にリスナーが閉じるため、以後の `/readyz` は接続拒否になります（503 は返しません）。実行中のリクエストだけが完了まで処理されます。ローリング更新ではロードバランサから外してから `SIGTERM` を送る（`preStop` で数秒待つ）と、停止中のインスタンスに新規リクエストが振られません
- 終了コード: `shutdown.done` で 0、`shutdown.timeout` / `shutdown.forced` / 起動時の設定エラー / セッションストアを開けない場合は 1（`restart:` ポリシーの判断に使えます）

## アップグレード

配布済みのコンテナイメージはありません。イメージは上記のとおりソースからビルドし、リリースは Git のタグ（`v0.1.0` など）と `CHANGELOG.md` で管理します。`main` は次のリリースに向けた変更を含みます（`[Unreleased]` 節）。

イメージを差し替えて再起動するだけです。`SESSION_STORE=sqlite`（本番既定）でボリュームを維持していれば利用者のセッションは継続します。`SESSION_SECRET` を変えると、次回起動時に保存済みセッションはすべて削除されます（ログ `session_store.reset`、全員再ログイン。0.1.0 で作られたファイルも、行が復号できなければ同様に削除されます）。スキーマや設定ファイルのマイグレーションはありません。

複数レプリカで動かす場合は同じ SQLite ファイルを共有できないため、ロードバランサをスティッキーセッションにし、**かつ**レプリカごとに別ボリュームを持たせてください（片方だけでは、別レプリカに振られた瞬間にログアウトになります）。

ロールバックも同じ手順（イメージを戻して再起動）です。セッション表は `CREATE TABLE IF NOT EXISTS` と列の追加だけで管理しており、旧バージョンが読めない行は破棄されます（該当利用者は再ログイン）。
