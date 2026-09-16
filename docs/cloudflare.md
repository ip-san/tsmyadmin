# Cloudflare へのデプロイ

*English: [docs/en/cloudflare.md](en/cloudflare.md)*

Cloudflare Containers で動かす手順です。先に [deployment.md](deployment.md) を読んでください。ここは差分だけを書いています。

## 先に読む: 何が動いて何が動かないか

**Workers 単体では動きません。** tsmyadmin は `node:sqlite`（セッションストア）、`mysql2` / `pg` の接続プール、`ioredis` を使います。いずれも Workers ランタイムにはなく、動かすには別物に書き換えることになります。Pages も静的配信だけなので API を置けません。

**Cloudflare Containers なら動きます。** 同梱の `Dockerfile` をそのまま使えます。ただし次の 3 つは前提条件で、外すと動きません。

| 条件 | 理由 |
|---|---|
| **`SESSION_STORE=redis` にする（必須）** | Containers のディスクは ephemeral で、インスタンスが眠るたびに初期状態に戻ります。既定の `sqlite` では、寝るたびに全員ログアウトし保存済みクエリも消えます |
| **イメージは `linux/amd64`** | Containers は amd64 のみです。Apple Silicon では `docker build --platform linux/amd64` |
| **Workers Paid プラン（$5/月〜）** | Containers は無料プランでは使えません |

## 接続先データベースへの到達性

Containers は既定（`enableInternet = true`）でインターネットに出られ、3306 / 5432 / 6379 のような HTTP 以外のポートにも接続できます。`outbound` ハンドラが横取りするのは 80 / 443 だけで、それ以外のポートは素通りします。

**`enableInternet = false` にすると壊れます。** その設定では「80 / 443 と DNS だけ」になり、データベースへの接続が拒否されます。tsmyadmin では設定しないでください。

- 公開されていないデータベース（VPC 内など）に繋ぐ場合は、[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) か Workers VPC を使ってください
- Redis も同じく到達できる必要があります。マネージドの Redis（TLS 付き、`rediss://`）が手軽です

> 到達性は Cloudflare のドキュメントの記述から確認したものです。実際に使うデータベースとポートで、最初に一度 `/readyz` とログインを確かめてください。

## 手順

### 1. wrangler の設定

リポジトリのルートに `wrangler.jsonc` を置きます。

```jsonc
{
  "name": "tsmyadmin",
  "main": "worker/index.ts",
  "compatibility_date": "2026-01-01",
  "containers": [
    {
      "class_name": "TsmyadminContainer",
      "image": "./Dockerfile",
      // 同時に立てるインスタンス数。接続プールはインスタンスごとに張られるので、
      // DB の max_connections をこの数で掛けて見積もってください。
      "max_instances": 2
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "TSMYADMIN", "class_name": "TsmyadminContainer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TsmyadminContainer"] }]
}
```

### 2. 前に置く Worker

`worker/index.ts`:

```ts
import { Container } from '@cloudflare/containers'

export class TsmyadminContainer extends Container {
  // Dockerfile の EXPOSE と揃えます。
  defaultPort = 3100
  // 既定は 10 分。短くするとコストは下がりますが、次のアクセスで起動を待ちます。
  sleepAfter = '30m'
  envVars = {
    NODE_ENV: 'production',
    SESSION_STORE: 'redis',
    // CF-Connecting-IP を使う。Worker 経由では X-Forwarded-For が付かないことがあり、
    // '1' のままだと全員が Worker の内部アドレスを共有してレート制限が 1 枠になる。
    TRUST_PROXY: 'cloudflare',
  }
}

export default {
  async fetch(request: Request, env: { TSMYADMIN: DurableObjectNamespace<TsmyadminContainer> }) {
    // 全員が同じセッションを共有するので、インスタンスは 1 つの名前に固定します。
    // 名前を分けるとログインが別インスタンスに飛んで毎回やり直しになります。
    return env.TSMYADMIN.getByName('default').fetch(request)
  },
}
```

### 3. 秘密情報

`SESSION_SECRET` と `REDIS_URL` は `envVars` に書かず、Worker のシークレットとして渡します。

```bash
npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32
npx wrangler secret put REDIS_URL        # rediss://…
npx wrangler secret put TSMYADMIN_ALLOWED_HOSTS   # db.example.com:5432 など
```

### 4. デプロイ

```bash
npx wrangler deploy
```

初回はイメージのビルドと push に時間がかかります。

## 運用上の違い

`deployment.md` の「複数レプリカ」で書いたことがそのまま当てはまり、さらに Containers 固有の点が加わります。

| 項目 | Containers での挙動 |
|---|---|
| ディスク | ephemeral。`SESSION_DB_PATH` は意味を持ちません |
| 起動と休止 | 10 分（`sleepAfter` で変更可）アイドルで停止し、次のアクセスで起動します。**起動直後の最初のリクエストは遅くなります** |
| 接続プール | 休止のたびに失われます。次のアクセスで張り直されるので利用者の再ログインは不要ですが、DB 側の接続数は上下します |
| 実行中クエリのキャンセル | インスタンスをまたぐと効きません。`max_instances` を 2 以上にするなら、`deployment.md` の「共有されないもの」の表をそのまま適用してください |
| ログインのレート制限 | インスタンスごとに数えるので、実効的な上限が `max_instances` 倍になります。`TRUST_PROXY=cloudflare` にしていないと、さらに全員が同じ 1 枠に入ります |
| 長い処理 | エクスポートやインポートの途中で `sleepAfter` に達しないよう、既定の 10 分より長くしてください |
| 料金 | Workers Paid に加えて、稼働 10 ミリ秒単位 + CPU 時間 + 下り転送で課金されます |

## 別の選び方: 前だけ Cloudflare にする

データベースが閉じたネットワークにある場合や、常駐プロセスのまま運用したい場合は、**アプリは今までどおりどこかで動かし、Cloudflare は入口だけ**にする構成が単純です。

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) で公開 IP なしに外から到達できるようにする
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) を前に置き、社内の ID で認証してから tsmyadmin に届くようにする（`deployment.md` が推奨している「到達性をネットワークで絞る」の具体形です）

この場合は `SESSION_STORE=sqlite` のままで構いません。ディスクが保つためです。
