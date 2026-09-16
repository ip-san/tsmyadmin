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

> **未検証の前提**（実機で確かめていません。最初のデプロイで必ず確認してください）
>
> 1. コンテナから DB / Redis のポートへ TCP が出られること — Cloudflare のドキュメントの記述から読み取ったものです。`/readyz` が 200 になり、ログインできれば通っています
> 2. `CF-Connecting-IP` が Worker からコンテナまで残ること — 残らないと全員が同じレート制限の枠に入ります。`event: http` のログの `ip` が利用者ごとに違うかで分かります
> 3. 停止時に SIGTERM と猶予があること — なければ実行中のエクスポートやインポートが切られます

## 手順

### 1. 同梱の設定を確認する

`wrangler.jsonc`（リポジトリのルート）と `deploy/cloudflare/worker.ts` がそのまま使えます。書き写す必要はありません。

- `wrangler.jsonc` — コンテナのクラス、`./Dockerfile`、`max_instances`
- `deploy/cloudflare/worker.ts` — 転送先ポート、`sleepAfter`、`SESSION_STORE=redis` と `TRUST_PROXY=cloudflare`

転送先ポートは `Dockerfile` の `EXPOSE` と一致している必要があり、ずれると `bun run check:static` が落ちます（`scripts/validate-docs.mjs`）。

### 2. 依存を入れる

```bash
bun add -d wrangler @cloudflare/containers
```

`deploy/cloudflare/worker.ts` は wrangler がデプロイ時にビルドします。ワークスペースには含めていないので `bun run check` の型検査の対象外です。

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

### 増やすには

上の Worker は `getByName('default')` で名前を 1 つに固定しているため、`max_instances` を上げても立つのは 1 つだけです。増やすなら、**同じ利用者が必ず同じ名前に振られる**ようにキーを決めてください（セッション Cookie の値など）。ばらけさせると、`deployment.md` の「複数レプリカ」で挙げた共有されないもの — 実行中クエリのキャンセル、ログインのレート制限、接続プール — がそのまま問題になります。

1 インスタンスで足りるかは利用者数ではなく同時実行数で決まります。管理ツールは大半の時間が待ちなので、数人で使うなら 1 つで足ります。

## 運用上の違い

`deployment.md` の「複数レプリカ」で書いたことがそのまま当てはまり、さらに Containers 固有の点が加わります。

| 項目 | Containers での挙動 |
|---|---|
| ディスク | ephemeral。`SESSION_DB_PATH` は意味を持ちません |
| 起動と休止 | 10 分（`sleepAfter` で変更可）アイドルで停止し、次のアクセスで起動します。**起動直後の最初のリクエストは遅くなります** |
| 接続プール | 休止のたびに失われます。次のアクセスで張り直されるので利用者の再ログインは不要ですが、DB 側の接続数は上下します |
| 実行中クエリのキャンセル | インスタンスをまたぐと効きません。名前を固定して 1 インスタンスで動かしている限りは起きません |
| ログインのレート制限 | `TRUST_PROXY=cloudflare` にしていないと全員が同じ 1 枠に入ります。インスタンスを増やした場合は、さらにインスタンスごとに数えます |
| 長い処理 | エクスポートやインポートの途中で `sleepAfter` に達しないよう、既定の 10 分より長くしてください |
| 料金 | Workers Paid に加えて、稼働 10 ミリ秒単位 + CPU 時間 + 下り転送で課金されます |

## 別の選び方: 前だけ Cloudflare にする

データベースが閉じたネットワークにある場合や、常駐プロセスのまま運用したい場合は、**アプリは今までどおりどこかで動かし、Cloudflare は入口だけ**にする構成が単純です。

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) で公開 IP なしに外から到達できるようにする
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) を前に置き、社内の ID で認証してから tsmyadmin に届くようにする（`deployment.md` が推奨している「到達性をネットワークで絞る」の具体形です）

この場合は `SESSION_STORE=sqlite` のままで構いません。ディスクが保つためです。
