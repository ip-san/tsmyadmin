# デプロイガイド

*English: [docs/en/deployment.md](en/deployment.md)*

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
| `SESSION_MAX_PER_IDENTITY` | `10`（1–1000） | 同じ DB アカウント（種別 / ホスト / ポート / ユーザー名）で同時に保持するセッション数。超えると最後に使われてから最も時間が経ったものを閉じる（LRU）（ログインの繰り返しで DB の `max_connections` を使い切らせない） |
| `SESSION_STORE` | 本番 `sqlite` / 開発 `memory` | `redis` は複数レプリカでセッションを共有（`REDIS_URL` が必須。下の「複数レプリカ」を必ず読むこと）。 `sqlite` は再起動・ローリング更新後もセッションを維持（資格情報は `SESSION_SECRET` から導出した鍵で AES-256-GCM 暗号化して保存）。保存済みクエリ・エクスポートのテンプレート・個人設定・セントラルカラム・列の表示変換も同じファイル・同じ鍵で保存され、DB アカウントに紐づく（アカウントあたり種類ごとに 200 件）。ユーザーグループと変更の追跡は、同じ DB サーバー（種別・ホスト・ポート）の全アカウントで共有する（種類ごとに 2,000 件。超えると古いものから消えるため、追跡のバージョンが多いサーバーでは古いバージョンから失われる）。`memory` はプロセス内のみで、これらは各ブラウザーに保存される |
| `SESSION_DB_PATH` | `data/sessions.sqlite` | `sqlite` 時のファイル。Docker では `/app/data` をボリュームにする |
| `REDIS_URL` | （なし） | `SESSION_STORE=redis` のとき必須（`redis://host:6379`、TLS は `rediss://`）。未設定なら起動時に終了する。セッションと保存済みクエリはここに入り、暗号化は sqlite と同一（`SESSION_SECRET` 由来の鍵、行ごとに結合） |
| `TSMYADMIN_ALLOWED_HOSTS` | `127.0.0.1,localhost` | ログイン画面から接続を許可する DB ホスト。カンマ区切りで、完全一致 / `*.suffix` / `*`（無制限）、それぞれ `:port` 付き可（`db.internal:5432`、`[::1]:3306`）。ポート省略は全ポート許可 — **本番ではポートまで指定する**（`docs/security.md`）。**SSRF・踏み台防止の要** |
| `TSMYADMIN_SERVERS` | （なし） | ログイン画面に出す接続先プリセットの JSON 配列。例: `[{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}]`。利用者はユーザー名とパスワードだけを入力。プリセットのホストは自動的に allowlist に加わる。**パスワードは書かない** |
| `TSMYADMIN_DOCKER_DISCOVERY` | `0` | `1` で、ローカルの Docker デーモンが動かしている MySQL / MariaDB / PostgreSQL のコンテナを、ログイン画面の接続先（`docker: プロジェクト/サービス`）に出し、その公開ポートへの接続を許可する。**開発専用**: Docker ソケットを読めることはホストの root 相当なので、`NODE_ENV=production` では起動時に拒否する。下の「Docker で開発用に使う」 |
| `TSMYADMIN_DOCKER_LOGIN` | `0` | `TSMYADMIN_DOCKER_DISCOVERY=1` と一緒に `1` にすると、検出したコンテナの環境変数（`MYSQL_ROOT_PASSWORD` / `POSTGRES_PASSWORD` など）から ログインの資格情報を読み、ログイン画面で**パスワードなしの 1 クリック**で接続できるようにする。パスワードはこのプロセスの中だけに置き、ブラウザには返さず、ログにも保存にも出さない。**開発専用**（`DISCOVERY` が本番で拒否されるので、本番では使えない）。下の「Docker で開発用に使う」 |
| `TSMYADMIN_DOCKER_SOCKET` | `/var/run/docker.sock` | 検出に使う Docker Engine API の Unix ソケット。GET しか発行しない |
| `TSMYADMIN_DOCKER_CONNECT_HOST` | ホスト上では `127.0.0.1` / コンテナ内では `host.docker.internal` | 検出したコンテナの公開ポートに、このプロセスから届くホスト名 |
| `LOGIN_RATE_LIMIT` | `10` | `LOGIN_RATE_WINDOW_SECONDS` 内に許可するログイン試行回数（クライアント IP + ユーザー名ごと。IP 単位では 3 倍まで） |
| `TSMYADMIN_REQUIRE_2FA` | `0` | `1` で全アカウントに 2 要素認証（TOTP）を必須にする。未登録のアカウントはログインできるが、登録を終えるまで他の操作はできない。秘密鍵の置き場が要るため `SESSION_STORE=sqlite` か `redis` が必須（`memory` では起動時に終了する）。既定の `0` では、登録したアカウントだけが 2 段階になる |
| `TSMYADMIN_PASSKEY_ORIGIN` | （空） | 利用者がブラウザで開く URL の origin（例 `https://db.example.com`）。設定すると、2 要素目にパスキー（WebAuthn）も使える。パスキーはこのホスト名に結び付くため、**後からドメインを変えると登録済みのパスキーはすべて使えなくなる**。HTTPS 必須（`http://localhost` だけ例外）、IP アドレスは不可、パスは付けない。`SESSION_STORE=sqlite` か `redis` が必須。空ならパスキーは出さない（認証アプリだけ） |
| `TSMYADMIN_IMAGE_HOSTS` | （空） | 列の表示変換「画像（URL から）」が画像を読み込んでよいホスト。カンマ区切りで `host` / `*.suffix`、それぞれ `:port` 付き可（ポート省略は既定のポート 80 / 443）。ここに書いたホストは CSP の `img-src` に加わり、それ以外の画像 URL は読み込まれずリンクとして表示される。**画像の URL を開くとそのホストに閲覧者の IP アドレスなどが伝わる**ため、信頼できるホストだけを書く。空なら外部の画像は読み込まない |
| `LOGIN_RATE_WINDOW_SECONDS` | `60` | 上記のウィンドウ（秒、1 以上。`LOGIN_RATE_LIMIT` も 1 以上） |
| `TRUST_PROXY` | `0` | `1` でリバースプロキシの `X-Forwarded-For` をクライアント IP として信頼する（プロキシ配下では必須、直接公開時は `0` のまま）。`cloudflare` にすると `CF-Connecting-IP` を優先する。この 2 つを分けているのは、`CF-Connecting-IP` を必ず上書きしてくれるのが Cloudflare だけだからで、それ以外の環境で信頼するとクライアントが自分で名乗れてしまう |
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
- イメージは非 root ユーザー `bun`（uid/gid 1000）で動作し、本番依存のみを含みます。`HEALTHCHECK` は `/readyz` を見ます（`API_PORT` / `PORT` に従うので、コンテナ内のポートを変えても機能します）。既定のファイルベースのストアならこれが正しい判定です。`SESSION_STORE=redis` ではストアが共有なので、コンテナの health で自動的に動くもの（Swarm、autoheal）は、Redis が 60〜90 秒以上続けて落ちると全コンテナを同時に再起動します（`--interval=30s --retries=3`。一瞬の断では発火しません）
- `/app/data` にセッションストアが置かれます。ボリュームを付けないと再起動で全員ログアウトになります（機能は損なわれません）。バインドマウントの場合は `chown 1000:1000 <dir>` が必要です
- `/healthz`（生存）と `/readyz`（セッションストアの疎通）を公開します。**オーケストレータやロードバランサのプローブには `/healthz` を使ってください。** `/readyz` が見るセッションストアは全レプリカで共有なので、プローブに使うと一瞬の Redis 断で全レプリカが同時に外れます（[hosting.md](hosting.md)）
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

イメージに `HEALTHCHECK`（`/readyz`）が組み込まれているため、compose 側で上書きする必要はありません。`SESSION_STORE=redis` で、health に応じて自動で動くもの（Swarm、autoheal）を使っている場合だけ `/healthz` に上書きしてください。実行イメージ（`oven/bun:1.4-slim`）には `curl` / `wget` がないので、次のように書いてください。

```yaml
healthcheck:
  # $$ は compose で $ を書くためのエスケープ。$ 1 つだと compose が ${process.env…} を自分の変数として展開しようとして起動に失敗します
  test: ["CMD", "bun", "-e", "fetch(`http://127.0.0.1:$${process.env.API_PORT || process.env.PORT || 3100}/healthz`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
```

置き場所ごとの違い（さくらの VPS などのサーバー、AWS、Azure）は [hosting.md](hosting.md) に、Cloudflare Containers は [cloudflare.md](cloudflare.md) にあります。

## Docker で開発用に使う（コンテナの自動検出）

開発マシンで動いている他のプロジェクトの MySQL / PostgreSQL コンテナを、接続先を書かずに開けます。ログイン画面に `docker: プロジェクト/サービス` の名前で並ぶので、選んでユーザー名とパスワードを入れるだけです。**本番では使えません**（`NODE_ENV=production` で `TSMYADMIN_DOCKER_DISCOVERY=1` を指定すると起動時に拒否します）。

リポジトリの `docker-compose.dev.yml` がそのまま使えます。

```bash
docker compose -f docker-compose.dev.yml up -d --build
# → http://localhost:3100 を開き、`docker:` で始まる接続先を選ぶ
```

`docker run` で同じことをする場合（イメージを作ってから）:

```bash
docker build -t tsmyadmin .
docker run -d --name tsmyadmin --user 0 \
  -p 127.0.0.1:3100:3100 \
  -e NODE_ENV=development \
  -e TSMYADMIN_DOCKER_DISCOVERY=1 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host=host.docker.internal:host-gateway \
  tsmyadmin
```

- `NODE_ENV=development`: イメージは既定で production なので、開発の既定（メモリのセッション、Secure なし）に上書きします
- `--user 0`（compose では `user: "0:0"`）: `docker.sock` は root（Linux では docker グループ）だけが読めます。イメージの既定の uid 1000 では開けず、検出は空になります。ソケットを渡した時点でホストの root 相当なので、root で動かしても権限は増えません

ホストで `bun run dev` している場合は、何も付けなくても有効です（接続先は `127.0.0.1` になります。切るときは `TSMYADMIN_DOCKER_DISCOVERY=0 bun run dev`）。ほかの方法で API を起動するときは `TSMYADMIN_DOCKER_DISCOVERY=1` を付けます。

- **見つかるもの**: イメージ名（`mysql` / `mariadb` / `percona` / `postgres` / `postgis` など）か、公開している 3306 / 5432 から MySQL・MariaDB・PostgreSQL と判断し、**ホストにポートを公開しているコンテナだけ**を出します。公開していないコンテナには、このプロセスから届きません。一覧は数秒ごとに取り直され、後から起動したコンテナもログイン画面を開き直すと出ます
- **接続できる範囲**: 検出したコンテナの公開 `ホスト:ポート` に限ります（同じホストの別ポートや、検出されていない先は `TSMYADMIN_ALLOWED_HOSTS` の設定どおり）。コンテナの環境変数から読むのは `MYSQL_DATABASE` / `MARIADB_DATABASE` / `POSTGRES_DB`（データベース名の入力補助）だけで、既定ではパスワードは読みも返しも記録もしません。ユーザー名とパスワードは各プロジェクトの設定を見て入力します（次の「ワンクリック ログイン」で読むように選べます）
- **ワンクリック ログイン（`TSMYADMIN_DOCKER_LOGIN=1`）**: 検出したコンテナの環境変数から、起動時に渡された資格情報を読みます。MySQL / MariaDB は `MYSQL_ROOT_PASSWORD` / `MARIADB_ROOT_PASSWORD`（root。`MYSQL_ALLOW_EMPTY_PASSWORD` / `MARIADB_ALLOW_EMPTY_ROOT_PASSWORD` なら空のパスワード）、なければ `MYSQL_USER` + `MYSQL_PASSWORD`（`MARIADB_` も同じ）。PostgreSQL は `POSTGRES_USER`（既定 `postgres`）+ `POSTGRES_PASSWORD`（`POSTGRES_HOST_AUTH_METHOD=trust` なら空）。見つかったコンテナだけ、ログイン画面でユーザー名とパスワードの欄が消え、「接続」の 1 回で入れます。読んだパスワードはこのプロセスの中だけに置き（ブラウザに返さず、ログや保存にも出しません）、接続先は検出したコンテナの `ホスト:ポート` に限ります。ただし、**このツールに届く人は、パスワードなしでそれらのデータベースに入れます**。`127.0.0.1` にだけ公開し（`-p 127.0.0.1:3100:3100`）、共有マシンや公開ネットワークでは使わないでください。既定はオフです
- **届く条件**: このプロセスから公開ポートに接続できる必要があります。Docker Desktop（macOS / Windows）は `host.docker.internal` で届きます。Linux の Docker Engine で、ホストの `127.0.0.1` だけに公開したポート（`127.0.0.1:5433:5432` など）は、コンテナからは届かないことがあります。その場合は `0.0.0.0` で公開するか、`TSMYADMIN_DOCKER_CONNECT_HOST` を届く名前にしてください。Docker に届かないとき（ソケットがない、権限がない）は、検出は空になり、理由が 1 回だけログに出ます
- **ソケットの権限**: `docker.sock` を `:ro` でマウントしても Docker API への書き込みは防げません（`:ro` はファイルシステムの操作を止めるだけです）。tsmyadmin は `GET /containers/json` と `GET /containers/<id>/json` しか発行しませんが、ソケットを渡す時点でコンテナ内のプロセスはホストの Docker を操作できます。信頼できる手元の開発環境だけで使い、公開ネットワークには出さないでください

## リバースプロキシと TLS

tsmyadmin 自身は TLS を終端しません。**必ず HTTPS を終端するリバースプロキシの背後に置いてください**（`NODE_ENV=production` では Cookie に `Secure` が付き、平文 HTTP でのログインは `HTTPS で接続してください` と拒否されます。ログには `login.insecure_transport` が出ます。TLS を終端しない社内ネットワークでは `COOKIE_SECURE=0`）。プロキシは `X-Forwarded-Proto` を付け、`TRUST_PROXY` を `1`（Cloudflare 経由なら `cloudflare`）にしてください。`0` のままだと HTTPS 経由でも平文と判定されます。

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

`TRUST_PROXY=1` を設定すると、レート制限とアクセスログが `X-Forwarded-For` の**末尾**のアドレス（直前のプロキシが追記した値）をクライアント IP として使います。`$proxy_add_x_forwarded_for` のように追記するプロキシでも、クライアントが先頭に偽の値を書いても影響しません。多段のときは注意が必要です。末尾は常に「直前のプロキシが見たアドレス」なので、多段ではその 1 つ手前のプロキシの IP になります。クライアント IP を届けたい場合は、**tsmyadmin の直前のプロキシで `X-Forwarded-For` をクライアント IP だけに正規化してから**渡してください。プロキシを介さず直接公開する場合は `0` のままにしてください（ヘッダー偽装でレート制限を回避されます）。

Cloudflare の背後に置く場合は `cloudflare` にしてください。`CF-Connecting-IP` を優先し、それがなければ `1` と同じ動きに戻ります。設定と手順は [cloudflare.md](cloudflare.md) にまとめてあります。

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
| DB 接続プール | ログインセッションごとに最大 4 接続（PostgreSQL は接続先データベースごとに 1 プール）。60 秒アイドルで接続を閉じ、セッション失効（`SESSION_TTL_MINUTES`）でプールごと破棄。DB 側の同時接続上限（`max_connections`）の目安は下の式 | adapter (`idleTimeout`) |

**`max_connections` の見積もり**

```
同時ログインするセッション数
  × 4                          プールあたりの接続数
  × 触れるデータベース数        PostgreSQL のみ（MySQL は 1 プールで USE 切替）
  + 実行中のキャンセル数         キャンセル 1 回につき専用接続 1 本（同じ実行への同時キャンセルは共有）
  + 5                           監視・管理用の余裕
```

ログインを繰り返して枯渇させられないよう、同じ DB アカウントで保持するセッション数は `SESSION_MAX_PER_IDENTITY`（既定 10）で頭打ちになります。最悪ケースを見るときは「同時ログインするセッション数」を「アカウント数 × `SESSION_MAX_PER_IDENTITY`」に置き換えてください。

## 停止と再起動（グレースフルシャットダウン）

`SIGTERM` / `SIGINT` を受けると新規接続の受付を止め、実行中のリクエストが終わるのを `SHUTDOWN_TIMEOUT_SECONDS`（既定 30 秒）まで待ってから各セッションの DB 接続プールを閉じて終了します。2 回目のシグナルか上限超過で即時終了します（1 秒以内に重ねて届いたシグナルは同じ停止要求とみなして無視します。`docker stop` が SIGTERM を二重に送ることがあるため）。

- Kubernetes では `terminationGracePeriodSeconds` を `SHUTDOWN_TIMEOUT_SECONDS + 5` 以上にしてください
- `SIGTERM` を受けた瞬間にリスナーが閉じるため、以後の `/readyz` は接続拒否になります（503 は返しません）。実行中のリクエストだけが完了まで処理されます。ローリング更新ではロードバランサから外してから `SIGTERM` を送る（`preStop` で数秒待つ）と、停止中のインスタンスに新規リクエストが振られません
- 終了コード: `shutdown.done` で 0、`shutdown.timeout` / `shutdown.forced` / 起動時の設定エラー / セッションストアを開けない場合は 1（`restart:` ポリシーの判断に使えます）

## アップグレード

配布済みのコンテナイメージはありません。イメージは上記のとおりソースからビルドし、リリースは Git のタグ（`v0.1.0` など）と `CHANGELOG.md` で管理します。`main` は次のリリースに向けた変更を含みます（`[Unreleased]` 節）。

イメージを差し替えて再起動するだけです。`SESSION_STORE=sqlite`（本番既定）でボリュームを維持していれば利用者のセッションは継続します。`SESSION_SECRET` を変えると、次回起動時に保存済みセッションはすべて削除されます（ログ `session_store.reset`、全員再ログイン。0.1.0 で作られたファイルも、行が復号できなければ同様に削除されます）。保存済みクエリの行も復号できなくなり、一覧から消えます（行は残りますが読み出されません）。スキーマや設定ファイルのマイグレーションはありません。

### 複数レプリカ

`SESSION_STORE=sqlite` では同じファイルを共有できないため、ロードバランサをスティッキーセッションにし、**かつ**レプリカごとに別ボリュームを持たせてください（片方だけでは、別レプリカに振られた瞬間にログアウトになります）。

`SESSION_STORE=redis` にすると、**セッションと保存済みクエリはレプリカ間で共有されます**。どのレプリカに振られてもログイン状態は続き、保存済みクエリも同じものが見えます。片方のレプリカでログアウトすれば全体で終了します。

**ただしこれで「複数レプリカ対応」になるわけではありません。** 次のものはプロセスごとに残るため、引き続きスティッキーセッションが必要です。

| 共有されないもの | スティッキーでない場合に起きること |
|---|---|
| 実行中クエリのキャンセル | キャンセル要求が、そのクエリを走らせていないレプリカに届くと無言で何も起きません。インポートの中止も同じです |
| ログインのレート制限 | プロセスごとにカウントするため、実効的な上限がレプリカ数倍になります |
| DB 接続プール | レプリカごとにセッション分のプールを張ります。`max_connections` の見積もりに**レプリカ数を掛けて**ください |
| ログアウト直後の接続 | あるレプリカで削除しても、他のレプリカが持っていたプールは次のアクセス（またはスイープ、最大 60 秒）まで残ります |

つまり Redis で得られるのは「レプリカを落としても・増やしてもログイン状態と保存済みクエリが失われない」ことであって、「どのリクエストがどのレプリカに行ってもよい」ことではありません。

ロールバックも同じ手順（イメージを戻して再起動）です。セッション表は `CREATE TABLE IF NOT EXISTS` と列の追加だけで管理しており、旧バージョンが読めない行は破棄されます（該当利用者は再ログイン）。行を行 ID に結び付けて暗号化する形式（`payload_format = 2`）より前のイメージに戻した場合、そのイメージはどの行も読めません。鍵の指紋は一致するのでファイル全体が作り直されることはなく、クラッシュもしません。セッションの行はアクセスされた時点で破棄されるため利用者は再ログインになり、保存済みクエリは一覧が空に見えますが行は残るので、新しいイメージに戻せばまた読めます。新しいイメージへ上げるときは既存の行をその場で読み替えるので、セッションも保存済みクエリも失われません。
