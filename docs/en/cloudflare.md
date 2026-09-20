<!-- translated-from: docs/cloudflare.md sha256:65db5144063d9e9db8afe778deeb3cea04ca86f9dcea56f7daa9f0ac6efd9da5 -->

# Deploying to Cloudflare

*日本語版: [docs/cloudflare.md](../cloudflare.md)*

It runs on Cloudflare Containers. The configuration is in the repository, so there is nothing to copy out of this page.

`bun run cf:check` runs right now, with no Cloudflare account — it does need Docker running. `bun run cf:deploy` comes after steps 1 and 2 below.

```bash
bun run cf:check     # does the config, the worker and the image build? (no account; needs Docker)
bun run cf:deploy    # deploy (after steps 1 and 2)
```

## What you are signing up for

| | |
|---|---|
| **What runs it** | Cloudflare Containers (the Workers Paid plan, from $5/month) |
| **What you may also need** | A Redis of your own. It runs without one, but sign-ins and saved queries are lost every time the instance sleeps |
| **What will not work** | Workers on their own, Pages |

**Workers alone will not run it.** tsmyadmin uses `node:sqlite` (the session store), the `mysql2` / `pg` connection pools and `ioredis`, none of which exist in the Workers runtime. Pages serves static files only, so the API has nowhere to live. **Containers run the `Dockerfile` in this repository as it is.**

**Redis matters because the disk does not survive.** A container's disk is ephemeral: every time an instance sleeps (or is redeployed) it starts again from the image. Without `REDIS_URL`, sessions go to `SESSION_STORE=sqlite` inside the container, so each time that happens **everyone is signed out and saved queries and personal settings are lost**. That is fine for a trial or a handful of users. To keep them, set up a managed Redis over TLS (`rediss://`) and store `REDIS_URL`; the worker then switches to `SESSION_STORE=redis`.

## Steps

### 1. Get ready

Two things to arrange first (the second is optional):

1. **The Workers Paid plan** (from $5/month), enabled in the Cloudflare dashboard. On the free plan, `bun run cf:deploy` fails
2. **(Optional) A Redis**, ideally managed and over TLS. Without one it runs on SQLite. You will need its connection URL in the next step

```bash
bunx wrangler login
```

`wrangler` and `@cloudflare/containers` are already dev dependencies. The configuration is these two files, and you should not normally need to change either:

- `wrangler.jsonc` (at the root) — the container class, `./Dockerfile`, `max_instances`
- `deploy/cloudflare/worker.ts` — the port it forwards to, `sleepAfter`, `SESSION_STORE` (`redis` when `REDIS_URL` is set, `sqlite` otherwise), `TRUST_PROXY=cloudflare`

> That port has to match `EXPOSE` in the `Dockerfile`. `bun run check:static` fails if they drift apart.

### 2. Store the secrets

```bash
bunx wrangler secret put SESSION_SECRET            # openssl rand -hex 32
bunx wrangler secret put REDIS_URL                 # rediss://… (optional; SQLite without it)
bunx wrangler secret put TSMYADMIN_ALLOWED_HOSTS   # db.example.com:5432
```

Add `TSMYADMIN_SERVERS` the same way if you use server presets ([deployment.md](deployment.md) lists every variable).

> A value stored with `wrangler secret put` reaches the **Worker**. The container receives only what `envVars` in `deploy/cloudflare/worker.ts` lists.
>
> The three above (and `TSMYADMIN_SERVERS`) are already listed there, so nothing is needed from you here. **When you add a further variable later, add it to that list too.** Missing one of the three required variables **still deploys successfully**. It fails on the first request instead, and `bunx wrangler tail` shows which one — `SESSION_SECRET is not set`. **Any other variable is silently ignored when it is not in `envVars`, and its built-in default applies** — `wrangler secret put SESSION_TTL_MINUTES` on its own raises no error and sessions still expire after 30 minutes.

### 3. Check, then deploy

```bash
bun run cf:check
bun run cf:deploy
```

The first build and push take the longest.

### 4. Confirm it actually works

**Confirm all three of these on the first deploy.** Each rests on an assumption only Cloudflare can settle, and each fails quietly.

| What to confirm | How | If it does not hold |
|---|---|---|
| TCP reaches the database and Redis | `/readyz` returns 200 (if you use Redis, it is reachable) and you can log in (the database is reachable) | Containers will not work. Giving the database a Cloudflare private network connection (`cloudflared`) would reach it, but that is not covered here. The dependable answer is *Only the front door* below |
| The client's IP arrives | The `ip` field of the `event: http` log lines differs per visitor | Everyone shares one rate-limit bucket and brute-force protection stops working. First check the startup log that `TRUST_PROXY=cloudflare` reached the container; if it did and the values are still identical, switch to *Only the front door* below |
| Stopping waits for work in flight | Redeploy with `bun run cf:deploy` during an export, and an export that finishes within `SHUTDOWN_TIMEOUT_SECONDS` (30 seconds by default) completes | An export or import in flight is cut off immediately |

> **Anything longer than the grace period is cut off by default.** To lengthen it, set `SHUTDOWN_TIMEOUT_SECONDS` (up to 600) **and add it to `envVars` in `deploy/cloudflare/worker.ts`** — for the same reason as step 2.

> **Verified, all of it locally**: `bun run cf:check`, `docker build --platform linux/amd64`, and booting the production image with the same environment Cloudflare gives it (`SESSION_STORE=redis` + `TRUST_PROXY=cloudflare` + the secrets; the `sqlite` path without `REDIS_URL` was not booted locally) — logging in to MySQL, the session landing in Redis, and the `ip` in the logs taking the value of a `CF-Connecting-IP` header supplied by hand.
>
> **Not verified**: running on a Cloudflare account. All three rows above are unverified. For the second one, what is verified is only that the header is read correctly when present — **whether Cloudflare actually supplies a distinct value per visitor is a separate question**, so confirm it after deploying.

### 5. Restrict who can reach it

Once deployed, the app is on `*.workers.dev` and **anyone can reach it**. [security.md](security.md) states that exposing it directly to the internet is not an intended use. Do not leave it sitting there with nothing but a login screen.

The straightforward answer is to put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of it, so people authenticate against your own identity provider before anything reaches tsmyadmin. (That combination is unverified here.)

## Constraints

| Item | On Containers |
|---|---|
| Disk | Ephemeral. `SESSION_DB_PATH` means nothing here |
| Starting and sleeping | Stops after `sleepAfter` idle (30 minutes as shipped) and starts again on the next request. **That first request is slow** |
| Connection pools | Lost every time the instance sleeps. They are rebuilt on the next request, so nobody signs in again, but the connection count at the database rises and falls |
| The login rate limit | Counted per visitor while `TRUST_PROXY=cloudflare` is working; one bucket for everyone if it is not |
| Long operations | `sleepAfter` is set above the 10-minute default so an export or import cannot run into it |
| Import size | Unchanged. tsmyadmin's own 64 MB cap is reached first and never gets near the [Worker request body limit](https://developers.cloudflare.com/workers/platform/limits/) (100 MB at the lowest). The 64 MB is a fixed constant with no setting to raise it, so a larger dump has to go straight into the database on any setup |
| Architecture | `linux/amd64` only. Building locally on Apple Silicon needs `docker build --platform linux/amd64` |
| Memory and CPU | `instance_type` in `wrangler.jsonc`, shipped as `basic` (1 GiB / 0.25 vCPU). **Leave it out and you get `lite` (256 MiB), where a large import kills the container** |
| Logs | `observability` is enabled in `wrangler.jsonc`. Left off, neither `wrangler tail` nor Workers Logs shows anything |
| Cost | On top of the Workers Paid plan: per 10 ms of runtime, CPU time, and egress. A larger `instance_type` costs more |

### Running more than one instance

The worker as shipped pins `getByName('default')`, so exactly one runs. To run more, pick a key that sends **the same person to the same name every time** (the session cookie, for instance), and raise `max_instances` in `wrangler.jsonc` (it ships as `1`). Changing only the name in the worker still leaves exactly one instance running. Spread requests around instead and everything listed under *Several replicas* in [deployment.md](deployment.md) starts to bite: cancelling a running query, the login rate limit, and the connection pools.

Whether you need more depends on concurrent work rather than headcount. An admin tool spends most of its time waiting, so one instance is plenty for a handful of people.

## Only the front door

If the database sits in a closed network, or you would rather keep a long-running process, it is simpler to **run the application where it runs today and let Cloudflare be the way in**:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — reachable from outside with no public IP. Same product as the `cloudflared` in step 4, pointed the other way: this carries **visitor → tsmyadmin**, not tsmyadmin → database
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) — authenticate against your own identity provider before anything reaches tsmyadmin, which is the concrete form of the "restrict who can reach it at the network level" that [security.md](security.md) asks for

With this shape the disk survives, so `SESSION_STORE=sqlite` is fine.
