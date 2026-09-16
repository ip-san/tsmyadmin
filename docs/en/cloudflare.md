<!-- translated-from: docs/cloudflare.md sha256:7e5be09918cedee92dcc21bc72e3ff67f34dd30454aef003d4d0a956d83a2f33 -->

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

> **Assumptions nobody has measured.** Check each on your first deploy.
>
> 1. That a container can open TCP to the database and Redis ports — read from Cloudflare's documentation, not observed. `/readyz` returning 200 and one successful login confirms it
> 2. That `CF-Connecting-IP` survives the hop from the Worker to the container — if it does not, everyone shares one rate-limit bucket. The `ip` field of the `event: http` log lines tells you: it should differ per visitor
> 3. That stopping sends SIGTERM and waits — if it does not, an export or import in flight is cut off

## Steps

### 1. Look at the configuration that ships with the repository

`wrangler.jsonc` (at the root) and `deploy/cloudflare/worker.ts` are ready to use — there is nothing to copy out of this page.

- `wrangler.jsonc` — the container class, `./Dockerfile`, `max_instances`
- `deploy/cloudflare/worker.ts` — the port it forwards to, `sleepAfter`, and `SESSION_STORE=redis` / `TRUST_PROXY=cloudflare`

That port has to match `EXPOSE` in the `Dockerfile`; `bun run check:static` fails if they drift apart (`scripts/validate-docs.mjs`).

### 2. Install the tooling

```bash
bun add -d wrangler @cloudflare/containers
```

`deploy/cloudflare/worker.ts` is built by wrangler at deploy time. It is outside the workspaces, so `bun run check` does not typecheck it.

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

### Running more than one

The Worker above pins `getByName('default')`, so raising `max_instances` still gives you one instance. To run more, choose a key that sends the same person to the same name every time (the session cookie, for instance). Spread requests around instead and everything under *Several replicas* in `deployment.md` starts to bite: cancelling a running query, the login rate limit, and the connection pools.

Whether one instance is enough depends on concurrent work rather than headcount. An admin tool spends most of its time waiting, so one is plenty for a handful of people.

## How running it here differs

Everything under *Several replicas* in `deployment.md` applies, plus what Containers add of their own:

| Item | On Containers |
|---|---|
| Disk | Ephemeral. `SESSION_DB_PATH` means nothing here |
| Starting and sleeping | Stops after 10 minutes idle (`sleepAfter` changes it) and starts again on the next request. **The first request after that is slow** |
| Connection pools | Lost every time the instance sleeps. They are rebuilt on the next request, so nobody has to sign in again, but the connection count at the database rises and falls |
| Cancelling a running query | Does not cross instances, which cannot arise while a single pinned name serves everyone |
| The login rate limit | Without `TRUST_PROXY=cloudflare`, everyone shares a single bucket. Run more than one instance and it is then counted per instance as well |
| Long operations | Raise `sleepAfter` above the default 10 minutes so an export or import cannot run into it |
| Cost | On top of the Workers Paid plan: per 10 ms of runtime, CPU time, and egress |

## The other option: put only the front door on Cloudflare

If the database sits in a closed network, or you would rather keep a long-running process, the simpler shape is to **run the application wherever it runs today and let Cloudflare be the way in**:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) makes it reachable without a public IP
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front authenticates against your own identity provider before anything reaches tsmyadmin — the concrete form of the "restrict who can reach it at the network level" that `deployment.md` recommends

With this shape `SESSION_STORE=sqlite` is fine, because the disk survives.
