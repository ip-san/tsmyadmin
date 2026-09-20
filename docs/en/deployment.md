<!-- translated-from: docs/deployment.md sha256:dec635e2e10a5ab3e04f325191b2cd283c6e92db72da08beedaf98e71088ce7c -->

# Deployment guide

*日本語版: [docs/deployment.md](../deployment.md)*

tsmyadmin runs as **a single container whose one process (Bun) serves both the API and the SPA**. The databases live outside it, as connection targets, and the only data tsmyadmin itself keeps is the session store (`/app/data/sessions.sqlite`, encrypted).

## Supported databases

| Kind | Versions | How it is verified |
|---|---|---|
| MySQL | 8.0 / 8.4 / 9 | The integration tests pass in full (8.0 and 8.4 on every CI run) |
| MariaDB | 10.11 (LTS) / 11 | The integration tests pass in full (both, on every CI run) |
| Percona Server | 8.4 | The integration tests pass in full (verified by hand) |
| PostgreSQL | 14 / 15 / 16 / 17 / 18 | The integration tests pass in full (14 and 17 on every CI run) |

- Older versions (MySQL 5.7, PostgreSQL 13 and earlier, MariaDB 10.6 and earlier) are not verified. On 5.7 some features do not work, because `information_schema` is laid out differently
- For **compatible engines**, "connects but some features do not work" is a measured result, not a guess. The more a feature depends on the catalog (`pg_catalog`, `information_schema`, `mysql.user`), the more it diverges.

  | Engine | Measured result | Verdict |
  |---|---|---|
  | TiDB 7.5 | 82 of 113 conformance cases pass. Browsing, running SQL (with the row limit), DDL and export all work. Stored routines, triggers and events are not supported by the server itself, so those lists come back empty or fail | Partly works (unsupported) |
  | CockroachDB 24.3 | 55 of 113 conformance cases pass. Browsing and basic SQL work, but anything resting on PostgreSQL's own catalog — sequences, inheritance, ctid, routines, triggers — fails broadly | Unsupported |

- Managed services built on the same engine as upstream (Aurora, Cloud SQL, AlloyDB …) are not verified, but are expected to work where the catalog is identical. Operations needing `SUPER`, `KILL` and `pg_terminate_backend` are subject to whatever the service allows
- Connecting needs a user on the target server. `SELECT` is enough to browse; individual features additionally need `SHOW VIEW`, `PROCESS`, `CREATE USER` and so on (see *A user with few privileges* in [operations.md](operations.md))

## Environment variables (the only list)

| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | `production` puts `Secure` on the cookie (overridable with `COOKIE_SECURE`), logs JSON, and requires `SESSION_SECRET` |
| `API_PORT` | `3100` | The port to listen on (1–65535). When unset, `PORT` (the variable PaaS platforms inject) is used instead. The Docker image `EXPOSE`s 3100, but its `HEALTHCHECK` follows the port actually in use |
| `COOKIE_SECURE` | `1` in production, `0` in development | `Secure` on the session cookie. With `1`, signing in over plain HTTP is refused with `INSECURE_TRANSPORT` (400), because the browser would throw the cookie away. Set it to `0` only on an internal network that does not terminate TLS. Plain access to `localhost`, `127.0.0.1` and `::1` is always allowed (Chrome and Firefox accept Secure cookies on localhost; Safari does not, so trying it in Safari still needs HTTPS or `COOKIE_SECURE=0`) |
| `SESSION_SECRET` | (a fixed development value) | The key the session cookie is signed with. **At least 32 characters, and mandatory, in production.** `openssl rand -hex 32` |
| `SESSION_TTL_MINUTES` | `30` | How long a session lives, extended by every action (1–1440) |
| `SESSION_MAX_PER_IDENTITY` | `10` (1–1000) | How many sessions one database account (type / host / port / username) may hold at once. Past that, the least recently used one is closed (LRU), so repeated logins cannot exhaust the database's `max_connections` |
| `SESSION_STORE` | `sqlite` in production, `memory` in development | `redis` shares sessions between replicas (`REDIS_URL` is required; read *Several replicas* below before using it). `sqlite` keeps sessions across restarts and rolling updates (credentials are stored AES-256-GCM encrypted, with a key derived from `SESSION_SECRET`). Saved queries, export templates, preferences, central columns and column transformations live in the same file under the same key and are tied to the database account (200 of each kind per account). User groups and change tracking are shared by every account of the same database server (dialect, host and port; 2,000 of each kind, beyond which the oldest go first — so on a server with many tracked versions, the oldest versions are lost first). `memory` keeps sessions in the process only, and these then stay in each browser |
| `SESSION_DB_PATH` | `data/sessions.sqlite` | The file used by `sqlite`. Under Docker, make `/app/data` a volume |
| `REDIS_URL` | (none) | Required with `SESSION_STORE=redis` (`redis://host:6379`, or `rediss://` for TLS). Without it the process exits at startup. Sessions and saved queries live here, encrypted exactly as the SQLite store encrypts them (a key derived from `SESSION_SECRET`, each value bound to its own key) |
| `TSMYADMIN_ALLOWED_HOSTS` | `127.0.0.1,localhost` | The database hosts the login screen may connect to. Comma-separated; each entry is an exact name, `*.suffix` or `*` (no restriction), optionally with `:port` (`db.internal:5432`, `[::1]:3306`). Leaving the port off allows every port — **name the port in production** (see [security.md](security.md)). **This is what stops SSRF and use as a jump host** |
| `TSMYADMIN_SERVERS` | (none) | A JSON array of the server presets offered on the login screen. For example: `[{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}]`. Users then enter only a username and password. A preset's host joins the allowlist automatically. **Never put a password here** |
| `TSMYADMIN_DOCKER_DISCOVERY` | `0` | `1` lists the MySQL / MariaDB / PostgreSQL containers the local Docker daemon is running as login targets (`docker: project/service`) and allows connecting to their published ports. **Development only**: being able to read the Docker socket is root on the host, so `NODE_ENV=production` refuses it at startup. See "Using it for development with Docker" below |
| `TSMYADMIN_DOCKER_SOCKET` | `/var/run/docker.sock` | The Unix socket of the Docker Engine API used for discovery. Only GET requests are issued |
| `TSMYADMIN_DOCKER_CONNECT_HOST` | `127.0.0.1` on the host / `host.docker.internal` in a container | The host name that reaches a discovered container's published port from where this process runs |
| `LOGIN_RATE_LIMIT` | `10` | How many sign-in attempts are allowed within `LOGIN_RATE_WINDOW_SECONDS`, per client IP and username (per IP alone, up to three times that) |
| `TSMYADMIN_REQUIRE_2FA` | `0` | `1` requires a second factor (TOTP) of every account: one that has not enrolled can log in but can do nothing until it has. It needs somewhere to keep the secrets, so `SESSION_STORE=sqlite` or `redis` is required (with `memory` the process exits at startup). At the default `0`, only accounts that enrol get the second step |
| `TSMYADMIN_PASSKEY_ORIGIN` | (empty) | The origin users open the app at (e.g. `https://db.example.com`). When set, passkeys (WebAuthn) can be the second factor too. A passkey is bound to this host name, so **moving to another domain later makes every enrolled passkey unusable**. HTTPS only (`http://localhost` is the exception), no IP address, no path. Needs `SESSION_STORE=sqlite` or `redis`. Empty: no passkeys (authenticator apps only) |
| `TSMYADMIN_IMAGE_HOSTS` | (empty) | Hosts the column display transformation "Image (from a URL)" may load pictures from. Comma-separated `host` / `*.suffix`, each optionally with `:port` (no port means the default one, 80 / 443). The hosts listed are added to the CSP's `img-src`; any other image URL is not loaded and is shown as a link. **Opening an image URL tells that host the viewer's IP address and more**, so list only hosts you trust. Empty: no outside pictures are loaded |
| `LOGIN_RATE_WINDOW_SECONDS` | `60` | The window for the above, in seconds (at least 1; `LOGIN_RATE_LIMIT` likewise) |
| `TRUST_PROXY` | `0` | `1` trusts a reverse proxy's `X-Forwarded-For` as the client IP (required behind a proxy; leave it `0` when exposed directly). `cloudflare` prefers `CF-Connecting-IP`. They are separate settings because only Cloudflare can be relied on to overwrite that header — anywhere else, trusting it lets a client name its own address |
| `LOG_FORMAT` | `json` in production, `pretty` in development | One JSON object per line (for a log collector), or a human-readable form |
| `WEB_DIST` | `apps/web/dist` | The directory of the SPA build to serve. When unset it is resolved from the location of the API source, so it does not depend on the working directory. If you do set it, use an absolute path or one relative to the working directory |
| `SHUTDOWN_TIMEOUT_SECONDS` | `30` (0–600) | How long to wait, after `SIGTERM`, for requests in flight (a long SQL statement, an export, an import) to finish. Past that the process exits immediately |

These are validated at startup: anything out of range or malformed prints the reason and exits with code 1 (the message always starts with `Invalid environment: ...`). An empty value (`NAME=`) counts as unset and takes the default. The one exception is `TSMYADMIN_ALLOWED_HOSTS=`, which means "do not even allow the default localhost — only the preset servers". An unknown key in a `TSMYADMIN_SERVERS` preset (`password`, say) is refused at startup.

Variables for development and testing only, ignored in production: `WEB_PORT` (the Vite dev server, 5175 by default), and `TEST_MYSQL_URL` / `TEST_PG_URL` (the compose databases the integration and E2E tests connect to).

## Docker

```bash
docker build -t tsmyadmin .
# To fill in the OCI labels (version / revision / created)
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

- Setting `TSMYADMIN_ALLOWED_HOSTS=` (the empty string) explicitly drops the default `127.0.0.1,localhost` — the container's own loopback, which production does not need and which warns about the missing port — and allows only the `host:port` of the presets. Without presets, list the `host:port` values yourself
- The image runs as the non-root user `bun` (uid/gid 1000) and contains production dependencies only. `HEALTHCHECK` looks at `/readyz` (it follows `API_PORT` / `PORT`, so changing the port inside the container still works). That is the right check for the default file-backed store. With `SESSION_STORE=redis` the store is shared, so anything that acts on container health by itself (Swarm, autoheal) restarts every container at once — but only after Redis has been down for 60–90 seconds (`--interval=30s --retries=3`), not on a blip
- The session store lives in `/app/data`. Without a volume, a restart signs everyone out (nothing else breaks). A bind mount needs `chown 1000:1000 <dir>`
- `/healthz` (liveness) and `/readyz` (the session store answers) are exposed. **Point an orchestrator's or load balancer's probe at `/healthz`.** The session store `/readyz` checks is shared by every replica under `SESSION_STORE=redis`, so probing it takes them all out of rotation together on a momentary Redis outage ([hosting.md](hosting.md))
- `--stop-timeout` (`stop_grace_period` in compose) defaults to 10 seconds in Docker, which is shorter than `SHUTDOWN_TIMEOUT_SECONDS` (30), so an export or import in flight would be cut off by SIGKILL. Set it to at least `SHUTDOWN_TIMEOUT_SECONDS + 5`
- Rough resources: 1 vCPU and 512 MB of memory. Idle sits around 90 MB; a 64 MB import (the whole file is held in memory) peaks in the hundreds of MB. Exports stream 500 rows at a time and do not depend on the size of the table. Do not set `--memory` below 256 MB

### A docker compose example

```yaml
services:
  tsmyadmin:
    image: tsmyadmin:latest
    restart: unless-stopped
    environment:
      NODE_ENV: production
      SESSION_SECRET: ${SESSION_SECRET:?set in .env}
      # `db` is an example of a database service on the same compose network. For an external database use host:port;
      # for one on the Docker Desktop host, host.docker.internal:5432
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

The image has a `HEALTHCHECK` (`/readyz`) built in, so compose does not need to override it. Override it with `/healthz` only when you run `SESSION_STORE=redis` together with something that acts on container health by itself (Swarm, autoheal). The runtime image (`oven/bun:1.4-slim`) has neither `curl` nor `wget`, so write it like this:

```yaml
healthcheck:
  # $$ is compose's escape for a literal $; without it compose tries to substitute ${process.env…} itself
  test: ["CMD", "bun", "-e", "fetch(`http://127.0.0.1:$${process.env.API_PORT || process.env.PORT || 3100}/healthz`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
```

What differs between places to run it — an ordinary server such as Sakura VPS, AWS, Azure — is covered by [hosting.md](hosting.md); Cloudflare Containers has its own page, [cloudflare.md](cloudflare.md).

## Using it for development with Docker (container discovery)

Open the MySQL / PostgreSQL containers of your other projects on the development machine without writing their addresses down. They appear on the login screen as `docker: project/service`: pick one and enter the username and password. **It cannot be used in production** (`TSMYADMIN_DOCKER_DISCOVERY=1` with `NODE_ENV=production` is refused at startup).

The repository's `docker-compose.dev.yml` works as it is.

```bash
docker compose -f docker-compose.dev.yml up -d --build
# → open http://localhost:3100 and pick a target that starts with `docker:`
```

To do the same with `docker run` (after building the image):

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

- `NODE_ENV=development`: the image defaults to production, so this overrides it with the development defaults (in-memory sessions, no Secure cookie)
- `--user 0` (`user: "0:0"` in compose): `docker.sock` is readable only by root (on Linux, the docker group). The image's default uid 1000 cannot open it and discovery comes up empty. Handing over the socket is already root on the host, so running as root adds no power

When you run `bun run dev` on the host, just set `TSMYADMIN_DOCKER_DISCOVERY=1` (targets are then `127.0.0.1`).

- **What is found**: a container is taken for MySQL, MariaDB or PostgreSQL by its image name (`mysql`, `mariadb`, `percona`, `postgres`, `postgis` and so on) or by publishing 3306 / 5432, and only **containers that publish the port on the host** are listed. One that publishes nothing cannot be reached from this process. The list is refreshed every few seconds, so a container started later shows up when the login screen is opened again
- **What may be connected to**: exactly the discovered containers' published `host:port` (another port on the same host, or a target that was not discovered, follows `TSMYADMIN_ALLOWED_HOSTS` as usual). From a container's environment only `MYSQL_DATABASE` / `MARIADB_DATABASE` / `POSTGRES_DB` are read, to prefill the database name; a password is never read, returned or logged. Enter the username and password from that project's own settings
- **When it reaches**: this process must be able to connect to the published port. Docker Desktop (macOS / Windows) reaches it through `host.docker.internal`. With Docker Engine on Linux, a port published only on the host's `127.0.0.1` (`127.0.0.1:5433:5432`, say) may not be reachable from a container: publish it on `0.0.0.0`, or set `TSMYADMIN_DOCKER_CONNECT_HOST` to a name that reaches it. When Docker cannot be reached (no socket, no permission), discovery is simply empty and the reason is logged once
- **The socket's power**: mounting `docker.sock` as `:ro` does not stop writes to the Docker API (`:ro` only stops file-system operations). tsmyadmin issues only `GET /containers/json` and `GET /containers/<id>/json`, but handing over the socket lets any process in the container drive the host's Docker. Use it only on a trusted development machine and never on a public network

## Reverse proxies and TLS

tsmyadmin does not terminate TLS itself. **Always put it behind a reverse proxy that terminates HTTPS.** (With `NODE_ENV=production` the cookie carries `Secure`, and signing in over plain HTTP is refused with *Connect over HTTPS*; the log records `login.insecure_transport`. On an internal network without TLS, use `COOKIE_SECURE=0`.) The proxy must set `X-Forwarded-Proto`, and `TRUST_PROXY` must be `1` (or `cloudflare` behind Cloudflare). Left at `0`, even HTTPS requests look like plain ones.

It works at the root of a host (`https://admin.example.com/`) only. It cannot be served under a sub-path (`https://example.com/tsmyadmin/`), because the asset and API paths are anchored at `/`.

`Strict-Transport-Security: max-age=15552000; includeSubDomains` is always returned (the `hono/secure-headers` default). Be careful if other services on the same apex domain are still served over HTTP.

An nginx example:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name admin.example.com;
  # ssl_certificate ...;

  # Restricting reachability — an internal network, a VPN, an SSO proxy — is strongly recommended
  allow 10.0.0.0/8;
  deny all;

  client_max_body_size 70m;   # the 64 MB import limit plus room for the multipart envelope
  # tsmyadmin gzips the SPA itself (the API is uncompressed, so an NDJSON stream arrives statement by statement).
  # If you compress in nginx, exclude the API: gzip on; gzip_types text/javascript application/javascript text/css;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;   # at least the API's own idle limit (255 s); exports send no heartbeat
    proxy_buffering off;       # pass the NDJSON progress and heartbeat lines straight through (buffering makes progress look stuck)
  }
}
```

With `TRUST_PROXY=1`, rate limiting and the access log take the client IP from the **last** address in `X-Forwarded-For` — the one the immediately preceding proxy appended. That holds even for a proxy that appends, as `$proxy_add_x_forwarded_for` does, and a client writing a forged value at the front changes nothing. Several proxies in a row need care: the last entry is always "the address the preceding proxy saw", so with a chain it is the IP of the proxy one hop further out. To get the real client IP through, **normalise `X-Forwarded-For` down to the client IP in the proxy directly in front of tsmyadmin**. When exposing it with no proxy at all, leave this at `0` — otherwise a forged header gets around the rate limit.

Behind Cloudflare, use `cloudflare`: it prefers `CF-Connecting-IP` and falls back to the `1` behaviour when that header is absent. [cloudflare.md](cloudflare.md) covers the setup.

## Running it directly (systemd)

Without Docker, install Bun 1.4 or newer and prepare it in this order.

1. `bun install --frozen-lockfile` (the build needs the development dependencies)
2. `bun run build` (writes the SPA to `apps/web/dist`)
3. Optional: `bun install --frozen-lockfile --production --ignore-scripts --filter '!@tsmyadmin/web'` to narrow it to the runtime dependencies, as the Docker image does (the built `apps/web/dist` is left alone)

Start it with `bun apps/api/src/index.ts`. `SESSION_DB_PATH` is relative to the working directory, so pin `WorkingDirectory` and make `data/` writable by the `User=`. Put at least `NODE_ENV=production`, `SESSION_SECRET` and `TSMYADMIN_ALLOWED_HOSTS` in the `EnvironmentFile`.

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

## Sizes and limits

| Item | Value | Where |
|---|---|---|
| One browse page | At most 1,000 rows. On a table estimated past 100,000 rows with no filter, `COUNT(*)` is skipped in favour of the catalog's estimate (*Approx. N rows*). A filtered count stops at 100,000 (*At least 100,000 rows*; jumping to the last page is then unavailable) | `BROWSE_MAX_LIMIT`, `EXACT_COUNT_MAX_ROWS` |
| SQL console result | 1,000 rows by default, 10,000 at most; 30 second timeout by default | `SQL_MAX_ROWS_*`, `SQL_TIMEOUT_DEFAULT_MS` |
| Import file | 64 MB | `IMPORT_MAX_BYTES` |
| Export | Streamed: 500 rows are read and sent at a time (even a MySQL table with neither a primary key nor a unique key is read as a row stream from a single SELECT) | `apps/api/src/lib/export.ts`, `iterateRows` |
| Keeping a long response alive | While running SQL or an import, a blank line (the NDJSON heartbeat) is sent every 15 seconds. An HTTP connection may idle for 255 seconds (Bun's limit); exports send no heartbeat, so a query that takes longer than that to produce its first row — sorting a huge table — is cut off. Set the idle timeout of your reverse proxy or load balancer (nginx `proxy_read_timeout`, an ALB idle timeout of 60 seconds by default …) to at least 255 seconds, and turn response buffering off (nginx `proxy_buffering off`) | `idleTimeout`, `HEARTBEAT_MS` |
| Binary values on screen | The first 64 KB | `MAX_BINARY_BYTES` |
| Long text on screen | The first 65,536 characters (shown as truncated, with the total character count; such a cell cannot be edited from the screen — update it with SQL. An export contains the whole value) | `MAX_TEXT_CHARS` |
| Database connection pool | At most 4 connections per login session (on PostgreSQL, one pool per database connected to). A connection is closed after 60 seconds idle, and the whole pool is discarded when the session expires (`SESSION_TTL_MINUTES`). The formula below sizes the database's own `max_connections` | adapter (`idleTimeout`) |

**Estimating `max_connections`**

```
sessions signed in at once
  × 4                         connections per pool
  × databases touched         PostgreSQL only (MySQL switches with USE on one pool)
  + cancellations in flight   each cancellation takes a connection of its own (concurrent cancels of the same run share one)
  + 5                         headroom for monitoring and administration
```

`SESSION_MAX_PER_IDENTITY` (10 by default) caps how many sessions one database account holds, so repeated logins cannot exhaust the server. For the worst case, replace "sessions signed in at once" with "number of accounts × `SESSION_MAX_PER_IDENTITY`".

## Stopping and restarting (graceful shutdown)

On `SIGTERM` or `SIGINT` the process stops accepting new connections, waits up to `SHUTDOWN_TIMEOUT_SECONDS` (30 by default) for requests in flight to finish, then closes each session's connection pool and exits. A second signal, or the timeout, ends it immediately. (A signal arriving within one second of another counts as the same stop request and is ignored, because `docker stop` sometimes sends SIGTERM twice.)

- On Kubernetes, set `terminationGracePeriodSeconds` to at least `SHUTDOWN_TIMEOUT_SECONDS + 5`
- The listener closes the moment `SIGTERM` arrives, so `/readyz` then refuses the connection rather than answering 503. Only requests already in flight run to completion. In a rolling update, take the instance out of the load balancer before sending `SIGTERM` (a `preStop` that waits a few seconds), so no new request is sent to an instance that is going away
- Exit codes: 0 on `shutdown.done`; 1 on `shutdown.timeout`, `shutdown.forced`, a configuration error at startup, or failing to open the session store (useful for a `restart:` policy)

## Upgrading

No container image is published. Build the image from source as above; releases are tracked with Git tags (`v0.1.0` and so on) and `CHANGELOG.md`. `main` carries the changes for the next release (the `[Unreleased]` section).

Upgrading is replacing the image and restarting. With `SESSION_STORE=sqlite` (the production default) and the volume kept, users' sessions continue. Changing `SESSION_SECRET` deletes every stored session at the next start (logged as `session_store.reset`; everyone signs in again — and a file created by 0.1.0 is cleared the same way when its rows cannot be decrypted). Saved query rows likewise become undecryptable and disappear from the list (the rows remain but are never read). There are no schema or configuration file migrations.

### Several replicas

With `SESSION_STORE=sqlite` the file cannot be shared, so make the load balancer sticky **and** give each replica its own volume. One without the other signs a user out the moment they are routed to a different replica.

With `SESSION_STORE=redis`, **sessions and saved queries are shared between replicas.** Whichever replica a request lands on, the user stays signed in and sees the same saved queries, and signing out on one ends the session everywhere.

**This does not make the application replica-safe.** The following stay inside the process that created them, so sticky sessions are still required:

| Not shared | What happens without stickiness |
|---|---|
| Cancelling a running query | A cancel that lands on a replica which is not running the query does nothing, silently. The same goes for stopping an import |
| The login rate limit | Counted per process, so the effective limit is multiplied by the number of replicas |
| Database connection pools | Each replica opens its own pool per session — multiply the `max_connections` estimate **by the number of replicas** |
| Connections just after a logout | Deleting on one replica leaves another replica's pool open until its next use or sweep (up to 60 seconds) |

So what Redis buys is that losing or adding a replica costs nobody their session or their saved queries — not that any request may go to any replica.

Rolling back is the same procedure: put the old image back and restart. The session table is managed with `CREATE TABLE IF NOT EXISTS` and added columns only, and a row an older version cannot read is discarded (that user signs in again). Going back past the release that binds each payload to its row (`payload_format = 2`), the older image can read no row at all. The key fingerprint still matches, so the file as a whole is not recreated and nothing crashes: session rows are discarded as they are read, so users sign in again, and saved queries look like an empty list while their rows stay in the file — rolling forward shows them again. Upgrading re-seals the existing rows in place, so neither sessions nor saved queries are lost.
