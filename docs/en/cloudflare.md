<!-- translated-from: docs/cloudflare.md sha256:12e72b1698d7586df1a16ce06c980ac901df64b0ff27bdeebb846f8c6c5abf27 -->

# Deploying to Cloudflare

*日本語版: [docs/cloudflare.md](../cloudflare.md)*

On Cloudflare Containers. The configuration is in the repository, so there is nothing to copy out of this page.

```bash
bun run cf:check     # does the config, the worker and the image build? (no account needed)
bun run cf:deploy    # deploy
```

## What you are signing up for

| | |
|---|---|
| **What runs it** | Cloudflare Containers (the Workers Paid plan, from $5/month) |
| **What you also need** | A Redis of your own. `SESSION_STORE=redis` is required |
| **What will not work** | Workers on their own, Pages |

**Workers alone will not run it.** tsmyadmin uses `node:sqlite` (the session store), the `mysql2` / `pg` connection pools and `ioredis`, none of which exist in the Workers runtime. Pages serves static files only, so the API has nowhere to live. **Containers run the `Dockerfile` in this repository as it is.**

**Redis is required because the disk does not survive.** A container's disk is ephemeral: every time an instance sleeps it starts again from the image. With the default `SESSION_STORE=sqlite`, everyone is signed out and every saved query is lost each time that happens. A managed Redis over TLS (`rediss://`) is the easy answer.

## Steps

### 1. Get ready

```bash
npx wrangler login
```

`wrangler` and `@cloudflare/containers` are already dev dependencies. The configuration is these two files, and you should not normally need to change either:

- `wrangler.jsonc` (at the root) — the container class, `./Dockerfile`, `max_instances`
- `deploy/cloudflare/worker.ts` — the port it forwards to, `sleepAfter`, `SESSION_STORE=redis`, `TRUST_PROXY=cloudflare`

> That port has to match `EXPOSE` in the `Dockerfile`. `bun run check:static` fails if they drift apart.

### 2. Store the secrets

```bash
npx wrangler secret put SESSION_SECRET            # openssl rand -hex 32
npx wrangler secret put REDIS_URL                 # rediss://…
npx wrangler secret put TSMYADMIN_ALLOWED_HOSTS   # db.example.com:5432
```

Add `TSMYADMIN_SERVERS` the same way if you use server presets ([deployment.md](deployment.md) lists every variable).

> A value stored with `wrangler secret put` reaches the **Worker**. The container receives only what `envVars` in `deploy/cloudflare/worker.ts` lists, so adding a variable means adding it there too. Miss one and the process exits at startup with `Invalid environment: …`.

### 3. Check, then deploy

```bash
bun run cf:check
bun run cf:deploy
```

The first build and push take the longest.

### 4. Confirm it actually works

**Do this on the first deploy.** Each row below is an assumption that only Cloudflare can settle, and each fails quietly.

| What to confirm | How | If it does not hold |
|---|---|---|
| TCP reaches the database and Redis | `/readyz` returns 200 and you can log in | Containers will not work. Put the database behind a Tunnel, or see *Only the front door* below |
| The client's IP arrives | The `ip` field of the `event: http` log lines differs per visitor | Everyone shares one rate-limit bucket and brute-force protection stops working |
| Stopping waits for work in flight | A long export runs to completion | An export or import in flight is cut off |

> **Verified**: `bun run cf:check` (the config, the worker and the image all build), `docker build --platform linux/amd64`, and booting the production image with the same environment Cloudflare gives it (`SESSION_STORE=redis` + `TRUST_PROXY=cloudflare` + the secrets) — logging in to MySQL, the session landing in Redis, and `CF-Connecting-IP` showing up as `ip` in the logs.
>
> **Not verified**: running on a Cloudflare account at all. The three rows above rest on Cloudflare's documentation and have not been measured on the real thing.

## Constraints

| Item | On Containers |
|---|---|
| Disk | Ephemeral. `SESSION_DB_PATH` means nothing here |
| Starting and sleeping | Stops after `sleepAfter` idle (30 minutes as shipped) and starts again on the next request. **That first request is slow** |
| Connection pools | Lost every time the instance sleeps. They are rebuilt on the next request, so nobody signs in again, but the connection count at the database rises and falls |
| The login rate limit | Counted per visitor while `TRUST_PROXY=cloudflare` is working; one bucket for everyone if it is not |
| Long operations | `sleepAfter` is set above the 10-minute default so an export or import cannot run into it |
| Architecture | `linux/amd64` only. Building locally on Apple Silicon needs `docker build --platform linux/amd64` |
| Cost | On top of the Workers Paid plan: per 10 ms of runtime, CPU time, and egress |

### Running more than one instance

The worker as shipped pins `getByName('default')`, so exactly one runs. To run more, pick a key that sends **the same person to the same name every time** (the session cookie, for instance). Spread requests around instead and everything listed under *Several replicas* in [deployment.md](deployment.md) starts to bite: cancelling a running query, the login rate limit, and the connection pools.

Whether you need more depends on concurrent work rather than headcount. An admin tool spends most of its time waiting, so one instance is plenty for a handful of people.

## Only the front door

If the database sits in a closed network, or you would rather keep a long-running process, it is simpler to **run the application where it runs today and let Cloudflare be the way in**:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — reachable from outside with no public IP
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) — authenticate against your own identity provider before anything reaches tsmyadmin, which is the concrete form of the "restrict who can reach it at the network level" that [security.md](security.md) asks for

With this shape the disk survives, so `SESSION_STORE=sqlite` is fine.
