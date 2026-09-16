<!-- translated-from: docs/cloudflare.md sha256:c423db8e5ebd7d713b313c49493ffbf53b1966fac25f9edfdb70f98713bc4231 -->

# Deploying to Cloudflare

*日本語版: [docs/cloudflare.md](../cloudflare.md)*

How to run tsmyadmin on Cloudflare Containers. Read [deployment.md](deployment.md) first — only the differences are here.

## Read this first: what works and what does not

**Workers alone will not run it.** tsmyadmin uses `node:sqlite` (the session store), the `mysql2` / `pg` connection pools and `ioredis`. None of those exist in the Workers runtime, and getting there means replacing them. Pages serves static files only, so the API has nowhere to live.

**Cloudflare Containers will run it**, from the `Dockerfile` in the repository, as it is. Three things are required, and leaving any of them out breaks it:

| Requirement | Why |
|---|---|
| **`SESSION_STORE=redis` (mandatory)** | A container's disk is ephemeral: every time an instance sleeps it starts again from the image. With the default `sqlite` store, everyone is signed out and every saved query is lost each time that happens |
| **An `linux/amd64` image** | Containers run amd64 only. On Apple Silicon, `docker build --platform linux/amd64` |
| **The Workers Paid plan (from $5/month)** | Containers are not available on the free plan |

## Reaching the database

By default (`enableInternet = true`) a container can reach the internet, including non-HTTP ports such as 3306, 5432 and 6379. The `outbound` handler only intercepts 80 and 443; other ports pass straight through.

**Setting `enableInternet = false` breaks it.** That setting leaves only ports 80, 443 and DNS, and the database connection is denied. Do not set it for tsmyadmin.

- For a database that is not on the public internet (inside a VPC, say), use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or Workers VPC
- Redis has to be reachable too; a managed Redis over TLS (`rediss://`) is the easy answer

> This reachability is what Cloudflare's documentation describes, not something measured here. Check `/readyz` and one login against your own database and port before relying on it.

## Steps

### 1. The wrangler configuration

Put `wrangler.jsonc` at the root of the repository:

```jsonc
{
  "name": "tsmyadmin",
  "main": "worker/index.ts",
  "compatibility_date": "2026-01-01",
  "containers": [
    {
      "class_name": "TsmyadminContainer",
      "image": "./Dockerfile",
      // How many instances may run at once. Each one opens its own connection pools, so multiply your
      // max_connections estimate by this number.
      "max_instances": 2
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "TSMYADMIN", "class_name": "TsmyadminContainer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TsmyadminContainer"] }]
}
```

### 2. The Worker in front

`worker/index.ts`:

```ts
import { Container } from '@cloudflare/containers'

export class TsmyadminContainer extends Container {
  // Matches EXPOSE in the Dockerfile.
  defaultPort = 3100
  // 10 minutes by default. Shorter costs less but makes the next visitor wait for a cold start.
  sleepAfter = '30m'
  envVars = {
    NODE_ENV: 'production',
    SESSION_STORE: 'redis',
    // Use CF-Connecting-IP. A request forwarded by a Worker may carry no X-Forwarded-For, and with '1'
    // every visitor would then share the Worker's own address — one rate-limit bucket for everyone.
    TRUST_PROXY: 'cloudflare',
  }
}

export default {
  async fetch(request: Request, env: { TSMYADMIN: DurableObjectNamespace<TsmyadminContainer> }) {
    // One fixed name, so everyone shares the same instance. Spreading requests over several names sends a
    // login to one instance and the next request to another, which starts the login over.
    return env.TSMYADMIN.getByName('default').fetch(request)
  },
}
```

### 3. Secrets

Pass `SESSION_SECRET` and `REDIS_URL` as Worker secrets rather than putting them in `envVars`:

```bash
npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32
npx wrangler secret put REDIS_URL        # rediss://…
npx wrangler secret put TSMYADMIN_ALLOWED_HOSTS   # db.example.com:5432
```

### 4. Deploy

```bash
npx wrangler deploy
```

The first build and push take the longest.

## How running it here differs

Everything under *Several replicas* in `deployment.md` applies, plus what Containers add of their own:

| Item | On Containers |
|---|---|
| Disk | Ephemeral. `SESSION_DB_PATH` means nothing here |
| Starting and sleeping | Stops after 10 minutes idle (`sleepAfter` changes it) and starts again on the next request. **The first request after that is slow** |
| Connection pools | Lost every time the instance sleeps. They are rebuilt on the next request, so nobody has to sign in again, but the connection count at the database rises and falls |
| Cancelling a running query | Does not cross instances. With `max_instances` above 1, the table of what is not shared in `deployment.md` applies as written |
| The login rate limit | Counted per instance, so the effective limit is multiplied by `max_instances`. Without `TRUST_PROXY=cloudflare`, everyone also shares a single bucket |
| Long operations | Raise `sleepAfter` above the default 10 minutes so an export or import cannot run into it |
| Cost | On top of the Workers Paid plan: per 10 ms of runtime, CPU time, and egress |

## The other option: put only the front door on Cloudflare

If the database sits in a closed network, or you would rather keep a long-running process, the simpler shape is to **run the application wherever it runs today and let Cloudflare be the way in**:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) makes it reachable without a public IP
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front authenticates against your own identity provider before anything reaches tsmyadmin — the concrete form of the "restrict who can reach it at the network level" that `deployment.md` recommends

With this shape `SESSION_STORE=sqlite` is fine, because the disk survives.
