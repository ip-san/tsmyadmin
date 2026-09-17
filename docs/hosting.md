# どこで動かすか（VPS / AWS / Azure）

*English: [docs/en/hosting.md](en/hosting.md)*

環境変数・Docker の使い方・リバースプロキシの設定は [deployment.md](deployment.md) が唯一の一覧です。このページは**置き場所ごとに違うところだけ**をまとめます。Cloudflare Containers は [cloudflare.md](cloudflare.md) にあります。

## まず 1 つ決める: ディスクが残るか

これだけでセッションストアが決まります。

| ディスク | 例 | `SESSION_STORE` |
|---|---|---|
| 残る | さくらの VPS、EC2、Lightsail、Azure VM | `sqlite`（ボリュームを維持） |
| 消える | ECS Fargate、App Runner、Azure Container Apps、App Service for Containers（未確認） | `redis`（`REDIS_URL` 必須） |

消えるディスクで `sqlite` のままにすると、コンテナが入れ替わるたびに全員ログアウトし、保存済みクエリも消えます。

## どこでも共通

| 項目 | 設定 |
|---|---|
| TLS | tsmyadmin は TLS を終端しません。必ず前段で終端します |
| `TRUST_PROXY` | 前段があるなら `1`。前段なしで直接公開する構成（TLS のない閉じたネットワークだけ）では `0` のままにし、あわせて `COOKIE_SECURE=0` が必要です。本番は既定で HTTPS 以外のログインを拒否します |
| ヘルスチェック | ロードバランサには `/healthz`。**`/readyz` が見るのはセッションストア**（`redis` なら Redis）で、接続先 DB ではありません |
| メモリ | 512 MB 以上（[deployment.md](deployment.md) の「Docker」。アイドル約 90 MB、64 MB のインポート中だけピークが数百 MB）。256 MB を下回らせないでください |
| 複数インスタンス | セッションを共有しても、実行中クエリのキャンセル・ログインのレート制限・接続プールはインスタンスごとに残ります。2 つ以上動かすならスティッキーセッションが必須です（[deployment.md](deployment.md) の「複数レプリカ」）。有効にできないなら 1 つに固定してください |
| ポート | 既定 3100。`API_PORT` で変えられます。`API_PORT` を設定していないときだけ、プラットフォームが注入する `PORT` に従います（両方あれば `API_PORT` が優先） |
| 到達制限 | [security.md](security.md) は「インターネットに直接公開する用途は想定していない」としています。VPN・IP 制限・SSO のいずれかを前に置いてください |

> `TRUST_PROXY=1` は `X-Forwarded-For` の**末尾**を採ります。多段のときは、tsmyadmin の直前のプロキシでクライアント IP だけに正規化してください（[deployment.md](deployment.md) の「リバースプロキシと TLS」）。

---

## さくらの VPS など（普通のサーバー）

ConoHa、EC2、Lightsail、Azure VM も同じです。**ディスクが残るので一番単純**です。

1. Docker を入れる
2. tsmyadmin を建てる（`docker compose`。例は [deployment.md](deployment.md)）
3. 前段に TLS を終端するリバースプロキシを置く

```yaml
# compose の要点だけ。全体は deployment.md
services:
  tsmyadmin:
    image: tsmyadmin:latest       # 配布イメージはありません。`docker build -t tsmyadmin .` で自分でビルドします
    environment:
      NODE_ENV: production
      SESSION_SECRET: "…"          # openssl rand -hex 32
      TSMYADMIN_ALLOWED_HOSTS: "db.example.com:3306"
      TRUST_PROXY: "1"
    ports:
      - "127.0.0.1:3100:3100"     # ループバックだけに公開。Caddy はここに繋ぎます
    volumes:
      - session:/app/data          # これを消すと全員ログアウトします
volumes:
  session:
```

前段は Caddy が短く済みます（Let's Encrypt が自動）。次の例は **Caddy をホスト側で動かす**前提です。Caddy も同じ compose に入れる場合、`127.0.0.1` は Caddy 自身のコンテナを指してしまうので、宛先をサービス名（`tsmyadmin:3100`）にしてください。

```caddyfile
tsmyadmin.example.com {
  reverse_proxy 127.0.0.1:3100
}
```

Caddy は `X-Forwarded-For` と `X-Forwarded-Proto` を自分で付けるので、`TRUST_PROXY=1` だけで噛み合います。nginx の例は [deployment.md](deployment.md) にあります。

**注意**: `127.0.0.1:` を付けずに `"3100:3100"` と書くと、3100 が外部に直接開きます。開いていると、リバースプロキシを迂回して `X-Forwarded-For` を自分で名乗れます。

---

## AWS

### ECS Fargate（ALB の後ろ）

| 項目 | 設定 |
|---|---|
| セッション | ElastiCache for Redis。`SESSION_STORE=redis` + `REDIS_URL=rediss://…` |
| TLS | ALB で終端。`TRUST_PROXY=1` |
| ヘルスチェック | ターゲットグループの Health check path は `/healthz`。`/readyz` を使うと、Redis が一瞬落ちただけで全タスクが同時に不健全と判定され、サービスごと入れ替わります |
| シークレット | Secrets Manager / SSM を `secrets` で渡します（`environment` に書くとタスク定義に平文で残ります） |
| 複数タスク | ALB のターゲットグループでスティッキーセッションを有効に |

`SESSION_STORE=redis` でもスティッキーが要る理由は [deployment.md](deployment.md) の「複数レプリカ」にあります。ログイン状態は共有されますが、実行中クエリのキャンセル・ログインのレート制限・接続プールはタスクごとに残ります。

ALB は `X-Forwarded-For` にクライアント IP を追記するので、1 段構成なら末尾がクライアント IP になります。

### App Runner

ALB も VPC も要らない分、手軽です。`PORT` が注入されるので tsmyadmin はそれに従います。TLS は App Runner が終端するので `TRUST_PROXY=1`。ディスクは消えるので Redis が必要です。RDS / ElastiCache に届かせるには VPC コネクタを設定してください。App Runner でスティッキーセッションを設定できるかは未確認なので、確認できるまでインスタンス数は 1 に固定してください。

### EC2 / Lightsail

上の「さくらの VPS など」と同じです。

---

## Azure

### Container Apps

| 項目 | 設定 |
|---|---|
| セッション | Azure Cache for Redis。`SESSION_STORE=redis` |
| TLS | Ingress が終端。`TRUST_PROXY=1` |
| ポート | Ingress の target port を 3100 に |
| ヘルスチェック | Startup / Readiness / Liveness すべて `/healthz`。`/readyz` を Readiness に使うと、Redis が一瞬落ちただけで全レプリカが同時に ingress から外れます（ECS の行と同じ理由） |
| レプリカ | 最小 1。0 まで縮めるとアクセスのたびにコールドスタートします。2 つ以上にするなら Ingress のセッションアフィニティを有効に |
| シークレット | Container Apps のシークレットを環境変数に割り当てます |

### App Service for Containers

セッションは `redis` にしてください（コンテナのファイルシステムが再起動をまたいで残るかは未確認です）。あわせて `WEBSITES_PORT` に 3100 を設定する必要があります。

このサービスは `X-Forwarded-For` にポート番号を付けて渡すことがあります（`1.2.3.4:56789`）。tsmyadmin は末尾のポートを落としてから使うので、レート制限は IP 単位のまま保たれます。

### VM

上の「さくらの VPS など」と同じです。

---

> ここに挙げた前段の形は、`apps/api/src/platform-conformance.test.ts` で全部テストしています。各形について「利用者を識別できるか」「1 人をレート制限しても他人が巻き込まれないか」「ユーザー名を変えながらの総当たりが止まるか」を確認しています。**新しい置き場所を足すときは、`PLATFORMS` にも同じ形を 1 行足してください。**

## 確認済みと未確認

**確認済み**: 本番イメージを `SESSION_STORE=redis` と `TRUST_PROXY` を設定して起動し、ログイン・セッションの Redis 書き込み・転送ヘッダーからのクライアント IP 取得までをローカルで確認しています。

**未確認**: AWS・Azure の実アカウントでの動作。上の各表は各サービスのドキュメントに基づくもので、実機では確かめていません。最初のデプロイでは、次の 3 点を必ず確認してください。

1. `/readyz` が 200 で、**かつ**ログインできる（前者は Redis、後者は DB への到達を意味します）
2. `event: http` のログの `ip` が利用者ごとに違う
3. エクスポート中にローリング更新をかけ、`SHUTDOWN_TIMEOUT_SECONDS`（既定 30 秒）以内に終わるエクスポートが完了する

Cloudflare での同じ確認は [cloudflare.md](cloudflare.md) にあります。
