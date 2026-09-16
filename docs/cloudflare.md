# Cloudflare へのデプロイ

*English: [docs/en/cloudflare.md](en/cloudflare.md)*

Cloudflare Containers で動かします。設定はリポジトリに入っているので、書き写すものはありません。

```bash
bun run cf:check     # 設定・worker・イメージがビルドできるか（アカウント不要）
bun run cf:deploy    # デプロイ
```

## まず把握すること

| | |
|---|---|
| **使うもの** | Cloudflare Containers（Workers Paid プラン、$5/月〜） |
| **別途必要** | 外部の Redis。`SESSION_STORE=redis` が必須です |
| **使えない** | Workers 単体、Pages |

**Workers 単体では動きません。** `node:sqlite`（セッションストア）、`mysql2` / `pg` の接続プール、`ioredis` を使っていて、いずれも Workers ランタイムにありません。Pages は静的配信だけなので API を置けません。**Containers なら同梱の `Dockerfile` がそのまま動きます。**

**Redis が必須なのはディスクが消えるからです。** Containers のディスクは ephemeral で、インスタンスが眠るたびに初期状態に戻ります。既定の `SESSION_STORE=sqlite` では、寝るたびに全員ログアウトし保存済みクエリも消えます。マネージドの Redis（TLS 付き、`rediss://`）が手軽です。

## 手順

### 1. 準備

```bash
npx wrangler login
```

`wrangler` と `@cloudflare/containers` は開発依存として入っています。設定は次の 2 つで、中身を変える必要は普通ありません。

- `wrangler.jsonc`（ルート）— コンテナのクラス、`./Dockerfile`、`max_instances`
- `deploy/cloudflare/worker.ts` — 転送先ポート、`sleepAfter`、`SESSION_STORE=redis`、`TRUST_PROXY=cloudflare`

> 転送先ポートは `Dockerfile` の `EXPOSE` と一致している必要があります。ずれると `bun run check:static` が落ちます。

### 2. 秘密情報を登録する

```bash
npx wrangler secret put SESSION_SECRET            # openssl rand -hex 32
npx wrangler secret put REDIS_URL                 # rediss://…
npx wrangler secret put TSMYADMIN_ALLOWED_HOSTS   # db.example.com:5432
```

接続先プリセットを使うなら `TSMYADMIN_SERVERS` も同様に登録します（変数の一覧は [deployment.md](deployment.md)）。

> `wrangler secret put` で登録した値が届くのは **Worker** までです。コンテナに渡るのは `deploy/cloudflare/worker.ts` の `envVars` に書いたものだけなので、変数を増やすときは同じファイルへの追記も必要です。渡し忘れると起動時に `Invalid environment: …` で終了します。

### 3. 確かめてからデプロイする

```bash
bun run cf:check
bun run cf:deploy
```

初回はイメージのビルドと push に時間がかかります。

### 4. 動いているか確認する

**最初のデプロイでは必ずここまで確認してください。** 以下は実機で確かめていない前提で、外れると静かに壊れます。

| 確認すること | 見かた | 外れていた場合 |
|---|---|---|
| DB / Redis へ TCP が出られる | `/readyz` が 200 で、ログインできる | Containers 案が成立しません。DB を Tunnel 経由にするか、下の「前だけ Cloudflare にする」へ |
| クライアント IP が届いている | `event: http` のログの `ip` が利用者ごとに違う | 全員が同じレート制限の枠に入り、総当たり対策が効きません |
| 停止時に猶予がある | 長いエクスポートが最後まで終わる | 実行中のエクスポート / インポートが切られます |

> ここまでの内容は Cloudflare のドキュメントから組み立てたもので、実際の Cloudflare アカウントでの動作確認はしていません。確認済みなのは `bun run cf:check`（設定・worker・イメージのビルドが通ること）と `docker build --platform linux/amd64`（amd64 でビルドできること）までです。

## 制約

| 項目 | Containers での挙動 |
|---|---|
| ディスク | ephemeral。`SESSION_DB_PATH` は意味を持ちません |
| 起動と休止 | `sleepAfter`（同梱の設定は 30 分）アイドルで停止し、次のアクセスで起動します。**起動直後の最初のリクエストは遅くなります** |
| 接続プール | 休止のたびに失われます。次のアクセスで張り直されるので再ログインは不要ですが、DB 側の接続数は上下します |
| ログインのレート制限 | `TRUST_PROXY=cloudflare` が効いていれば利用者ごとに数えます。効いていないと全員で 1 枠です |
| 長い処理 | エクスポートやインポートが `sleepAfter` に達しないよう、既定の 10 分より長くしてあります |
| アーキテクチャ | `linux/amd64` のみ。Apple Silicon で手元ビルドするときは `docker build --platform linux/amd64` |
| 料金 | Workers Paid に加えて、稼働 10 ミリ秒単位 + CPU 時間 + 下り転送 |

### インスタンスを増やすには

同梱の worker は `getByName('default')` で名前を固定しているため、立つのは 1 つだけです。増やすなら**同じ利用者が必ず同じ名前に振られる**キー（セッション Cookie の値など）を使ってください。ばらけさせると、[deployment.md](deployment.md) の「複数レプリカ」で挙げた共有されないもの — 実行中クエリのキャンセル、ログインのレート制限、接続プール — がそのまま問題になります。

必要かどうかは利用者数ではなく同時実行数で決まります。管理ツールは大半の時間が待ちなので、数人で使うなら 1 つで足ります。

## 別案: 前だけ Cloudflare にする

DB が閉じたネットワークにある場合や、常駐プロセスのまま運用したい場合は、**アプリは今の場所で動かし、Cloudflare は入口だけ**にするほうが単純です。

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — 公開 IP なしで外から到達できるようにする
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) — 社内の ID で認証してから tsmyadmin に届かせる（[security.md](security.md) が求めている「到達性をネットワークで絞る」の具体形です）

この場合、ディスクが保つので `SESSION_STORE=sqlite` のままで構いません。
