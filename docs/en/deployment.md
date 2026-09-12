<!-- translated-from: docs/deployment.md sha256:088cf95693c87838b887679b7d5c96528f3e0d9e1dfcfe7407c3b186eaebd0ca -->

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
| `SESSION_STORE` | `sqlite` in production, `memory` in development | `sqlite` keeps sessions across restarts and rolling updates (credentials are stored AES-256-GCM encrypted, with a key derived from `SESSION_SECRET`). Saved queries live in the same file under the same key and are tied to the database account (200 per account). `memory` keeps sessions in the process only, and saved queries then stay in each browser |
| `SESSION_DB_PATH` | `data/sessions.sqlite` | The file used by `sqlite`. Under Docker, make `/app/data` a volume |
| `TSMYADMIN_ALLOWED_HOSTS` | `127.0.0.1,localhost` | The database hosts the login screen may connect to. Comma-separated; each entry is an exact name, `*.suffix` or `*` (no restriction), optionally with `:port` (`db.internal:5432`, `[::1]:3306`). Leaving the port off allows every port — **name the port in production** (see [security.md](security.md)). **This is what stops SSRF and use as a jump host** |
| `TSMYADMIN_SERVERS` | (none) | A JSON array of the server presets offered on the login screen. For example: `[{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}]`. Users then enter only a username and password. A preset's host joins the allowlist automatically. **Never put a password here** |
| `LOGIN_RATE_LIMIT` | `10` | How many sign-in attempts are allowed within `LOGIN_RATE_WINDOW_SECONDS`, per client IP and username (per IP alone, up to three times that) |
| `LOGIN_RATE_WINDOW_SECONDS` | `60` | The window for the above, in seconds (at least 1; `LOGIN_RATE_LIMIT` likewise) |
| `TRUST_PROXY` | `0` | `1` trusts a reverse proxy's `X-Forwarded-For` as the client IP (required behind a proxy; leave it `0` when exposed directly) |
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
- The image runs as the non-root user `bun` (uid/gid 1000) and contains production dependencies only. `HEALTHCHECK` looks at `/readyz` (it follows `API_PORT` / `PORT`, so changing the port inside the container still works)
- The session store lives in `/app/data`. Without a volume, a restart signs everyone out (nothing else breaks). A bind mount needs `chown 1000:1000 <dir>`
- `/healthz` (liveness) and `/readyz` (the session store answers) are exposed for your orchestrator's probes
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

The image has a `HEALTHCHECK` (`/readyz`) built in, so compose does not need to override it. If you do override it, note that the runtime image (`oven/bun:1.4-slim`) has neither `curl` nor `wget`, so use `["CMD", "bun", "-e", "fetch('http://127.0.0.1:3100/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]`.

## Reverse proxies and TLS

tsmyadmin does not terminate TLS itself. **Always put it behind a reverse proxy that terminates HTTPS.** (With `NODE_ENV=production` the cookie carries `Secure`, and signing in over plain HTTP is refused with *Connect over HTTPS*; the log records `login.insecure_transport`. On an internal network without TLS, use `COOKIE_SECURE=0`.) The proxy must set `X-Forwarded-Proto`, and you must set `TRUST_PROXY=1` — without it, even HTTPS requests look like plain ones.

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

Several replicas cannot share one SQLite file, so make the load balancer sticky **and** give each replica its own volume. One without the other signs a user out the moment they are routed to a different replica.

Rolling back is the same procedure: put the old image back and restart. The session table is managed with `CREATE TABLE IF NOT EXISTS` and added columns only, and a row an older version cannot read is discarded (that user signs in again). Going back past the release that binds each payload to its row (`payload_format = 2`), the older image can read no row at all. The key fingerprint still matches, so the file as a whole is not recreated and nothing crashes: session rows are discarded as they are read, so users sign in again, and saved queries look like an empty list while their rows stay in the file — rolling forward shows them again. Upgrading re-seals the existing rows in place, so neither sessions nor saved queries are lost.
