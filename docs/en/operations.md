<!-- translated-from: docs/operations.md sha256:ee4f9e6bcc0f9f278ffbc6aef51db4052b2202c5d477f332c2d52e1c0c6ddc81 -->

# Operations guide

*日本語版: [docs/operations.md](../operations.md)*

## Health checks

| Path | Meaning | When it fails |
|---|---|---|
| `GET /healthz` | The process is answering (liveness) | Restart |
| `GET /readyz` | The session store is usable (readiness) | Take it out of rotation and look for a `readyz.failed` log line |

## Logs

The production default is one JSON object per line (`LOG_FORMAT=json`). The main events:

| `event` | Contents |
|---|---|
| `startup` / `shutdown.begin` / `shutdown.done` / `shutdown.timeout` / `shutdown.forced` | The startup configuration (port, allowed hosts, TTL); a graceful shutdown beginning, finishing, timing out, or being forced by a second signal (a repeat within one second is ignored) |
| `http` | The access log: `requestId`, `method`, `path`, `status`, `ms`, `ip`. Successful `/healthz` and `/readyz` (probes) and `/assets/*` (hashed static files the browser caches for a year) are not recorded. There is no log level setting; pick `warn` and `error` out in your log collector |
| `login.ok` / `login.failed` / `login.host_not_allowed` / `login.insecure_transport` / `login.rate_limited` / `logout` | Authentication events (they carry the host, the username and the first 16 characters of a hash of the session ID — never a password or a raw session ID) |
| `audit` | **The audit log**: every call that changes data, structure, an account or server state (`insertRow(s)`, `updateRow`, `deleteRows`, `executeSql`, `cancelQuery`, `killProcess`). It carries `requestId`, `dialect`, `dbUser`, `dbHost`, `database`, `schema`, `table`, row counts, the kind of key and the column names; for `executeSql`, the first 500 characters of the SQL plus the statement and error counts; and `ok`, `ms`. A failure records only `error` (the error code) and `nativeCode`, never the server's message. **Row values are never recorded** (a SQL console statement is recorded to 500 characters, so it can contain values; an import records only `<import>` and a character count, and nothing of the file itself). Passwords — in account operations and in `IDENTIFIED BY` / `PASSWORD` statements from the SQL console — are replaced with `****` |
| `readyz.failed` | The session store is unhealthy (`error` level) |
| `unhandled` | An unexpected exception (`error` level). It carries the `requestId` and a stack, and the response is `500 INTERNAL`; look it up by `X-Request-Id` |
| `export.aborted` | An export stream failed part-way (`error` level). Whatever was downloaded is incomplete |
| `session_store.open_failed` / `session_store.reset` | The SQLite session store could not be opened and the process exited (`path`, `error`, `hint`) / a changed `SESSION_SECRET` was detected and the stored sessions were deleted |
| `config.dev_secret` / `config.allowlist_without_port` / `config.cookie_insecure` / `web.dist_missing` | Configuration warnings (the development secret / an allowed host without a port / `COOKIE_SECURE=0` in production / no SPA build) |

`audit` covers DDL (which goes through `/sql`) and imports (`executeSql`, `insertRows`) as well. If you need the full text of a statement run in the SQL console, note that the log's `sql` is cut at 500 characters — deliberately short, because it can contain values. Password detection scans the first 8,000 characters only (running a regular expression over a 64 MB script would stall the event loop).

### Keeping and rotating logs

tsmyadmin writes logs **to standard output only**; it never writes or rotates files (the 12-factor way). Retention belongs to your container or process platform.

| Environment | Suggested setup |
|---|---|
| Docker on its own | `--log-driver json-file --log-opt max-size=50m --log-opt max-file=10` (the `logging:` section in compose). To keep `audit` events long-term, use a `--log-driver` such as `journald`, `fluentd` or `awslogs` |
| Kubernetes | The usual stdout collection (Fluent Bit, Vector …). Routing `event: audit` to its own index makes audit queries much easier |
| systemd (running it directly) | It goes to journald, so extract with `journalctl -u tsmyadmin -o cat \| jq 'select(.event=="audit")'`. Control the size with `SystemMaxUse=` |

Set audit log retention to your organisation's policy. A line is a few hundred bytes and there is one per changing operation, so even 10,000 operations a day is a few MB.

Extracting the `audit` lines:

```bash
docker logs tsmyadmin 2>&1 | jq -c 'select(.event=="audit") | {time, dbUser, action, database, table, ok}'
```

Every response carries an `X-Request-Id`. When a user reports a problem, look the `http` log up by that ID.

## Common situations

| Symptom | Cause and what to do |
|---|---|
| Exits at startup with `Invalid environment` | An environment variable has the wrong type or is missing. Fix the variable the message names |
| Sign-in returns 400 `INSECURE_TRANSPORT` (the screen says to connect over HTTPS because a session cannot be kept over HTTP; the log says `login.insecure_transport`) | The cookie is `Secure` (`NODE_ENV=production`) but the request arrived over plain HTTP. Terminate HTTPS, have the proxy set `X-Forwarded-Proto: https`, and set `TRUST_PROXY=1`. On an internal network without TLS, `COOKIE_SECURE=0` |
| Sign-in returns 403 `HOST_NOT_ALLOWED` | The target is not in `TSMYADMIN_ALLOWED_HOSTS` (the screen says the administrator has not allowed this server) |
| Sign-in returns 429 | The rate limit. Retry after `Retry-After` seconds. If it is a false positive, check `TRUST_PROXY` — behind a proxy with `0`, everyone shares one IP |
| Everyone is signed out after a restart | `SESSION_STORE=memory`, no volume, or a changed `SESSION_SECRET`. See the upgrade section of [deployment.md](deployment.md) |
| Exits at startup with `session_store.open_failed` (the container restart-loops) | The `bun` user (uid 1000) cannot write to `SESSION_DB_PATH` (`/app/data` under Docker). A bind mount needs `chown 1000:1000`. The `error` line reads `unable to open database file` or `attempt to write a readonly database` |
| `/readyz` returns 503 | The SQLite file became unreadable or corrupt after startup. Check the `error` in `readyz.failed` |
| A statement times out in the SQL console | 30 seconds by default. A run can be stopped with **Cancel** (`KILL QUERY` / `pg_cancel_backend`, audited as `cancelQuery`). Use Import (up to 10 minutes) for long bulk work |
| An import returns 413 `PAYLOAD_TOO_LARGE` (a file past 64 MB, or a body past 65 MB) | Split the file, and check the reverse proxy's `client_max_body_size` as well |
| **Kill** in the process list does not remove the connection | The database user lacks the privilege (`PROCESS` / `SUPER` on MySQL, the equivalent of `pg_signal_backend` on PostgreSQL) |

### Error codes at a glance

`STATUS_BY_CODE` in `apps/api/src/lib/errors.ts` is the authority for the codes the API returns. These are the ones that generate questions in production.

| Code | HTTP | Meaning and what to do |
|---|---|---|
| `UNAUTHENTICATED` | 401 | There is no session, or it expired. The screen returns to the login page by itself |
| `AUTH_FAILED` | 401 | The database credentials are wrong. No detail is returned, so the target's egress address is not disclosed |
| `CONNECTION_FAILED` | 502 | The target database cannot be reached. See *When the target database restarts or fails* below |
| `HOST_NOT_ALLOWED` | 403 | The target is not in `TSMYADMIN_ALLOWED_HOSTS` |
| `INSECURE_TRANSPORT` | 400 | As above: a `Secure` cookie was about to be issued over plain HTTP |
| `RATE_LIMITED` | 429 | The sign-in rate limit. Retry after `Retry-After` seconds |
| `FORBIDDEN` | 403 | The CSRF check (`hono/csrf`). It applies only to form-encoded POSTs (the import upload) and to requests with no body (signing out, `DELETE /api/session`), not to the JSON API. A current browser sends `Sec-Fetch-Site: same-origin` and passes. Where a proxy strips that header, or on an old browser, `Origin` is compared against the host instead — so a reverse proxy that rewrites `Host` produces a 403 (in nginx, `proxy_set_header Host $host`) |
| `PAYLOAD_TOO_LARGE` | 413 | The body or upload is over the limit. The limits are under *Sizes and limits* in [deployment.md](deployment.md) |
| `PERMISSION_DENIED` | 403 | The database user lacks a privilege. The message names the privilege needed |
| `KEY_MISMATCH` | 409 | Someone else changed the row you were updating (it no longer matched exactly one row, so it was rolled back). Reload the screen and try again |
| `QUERY_FAILED` | 400 | A SQL error, with a `nativeCode` (MySQL's `ER_*` or PostgreSQL's SQLSTATE). The SQL console's 30 second default timeout also lands here |
| `UNSUPPORTED` | 400 | An operation this dialect or server cannot do (a psql meta-command, routines on TiDB …) |
| `INTERNAL` | 500 | An unexpected exception. Look up the `unhandled` log line by `X-Request-Id` |

## When the target database restarts or fails

While a target database is down, any API that uses it returns `502 CONNECTION_FAILED` **immediately** rather than waiting (the screen says the database cannot be reached, with a retry button). The tsmyadmin process itself stays up, and `/healthz` and `/readyz` keep returning 200 — they report the health of tsmyadmin and its session store, not of a target database.

When the database comes back, the next request succeeds **on the same login session**: the pool is rebuilt and nobody has to sign in again. Measured with `docker restart`: MySQL 8.4 recovers after about 9 seconds and PostgreSQL 17 after about 1; every request in between is a 502, and no `error` level line is logged.

- A query that was running is lost on the server side, so that statement appears as an error in the result (with *Run in a single transaction* selected in an import, nothing from that file is applied)
- To have a load balancer health check reflect the target database, poll something like `GET /api/databases` (which needs a session) from your monitoring rather than using `/readyz`

## Whether an export is complete

Dumps are streamed. If the database connection fails part-way, the transfer is **aborted** (the browser treats it as a failed download) rather than leaving behind an incomplete file that looks finished. A SQL dump ends with `-- tsmyadmin dump complete (N objects)`, so that line tells you it is whole (a truncated JSON dump is syntactically invalid; for CSV, check the row count).

## Rough performance figures

Measured on local Docker (MySQL 8.4 / PostgreSQL 17) against a 200,000-row, 4-column table. The API process stays at about 90 MB RSS throughout.

| Operation | PostgreSQL | MySQL |
|---|---|---|
| One browse page (no filter, estimated count) | 0.02 s | 0.03 s |
| One browse page (filtered, exact count) | 0.04 s | 0.04 s |
| Browse at OFFSET 190,000 | 0.03 s | 0.03 s |
| 10,000 rows in the SQL console | 0.11 s | 0.06 s |
| Several statements in the SQL console | Each result is sent as its statement finishes (NDJSON) | Same |
| SQL export (200,000 rows, about 10 MB) | 1.9 s | 3.1 s |
| CSV / JSON export (200,000 rows) | 1.8 s | 2.9 s |
| Sidebar with 1,500 tables in one schema | Only visible rows are rendered (under 120 in the DOM); filtering is instant and shows a count | Same |

## A user with few privileges

A read-only account (`SELECT` alone) can browse, see structure, run SELECTs and export. Anything that changes is refused by the database and shown as `PERMISSION_DENIED` (403): the screen says the database user lacks the privilege the operation needs. MySQL's Users tab needs permission to read `mysql.user` (`SELECT ON mysql.*` or `CREATE USER`) and says so when it is missing. PostgreSQL's Users tab reads `pg_roles`, which anyone may do.

## What to monitor

- The rate of `status >= 500` in the `http` log, and the p95 of `ms`
- A spike in `login.failed` or `login.rate_limited` (a sign of brute forcing)
- The number of `error` level lines (`unhandled`, `export.aborted`, `readyz.failed`, `session_store.open_failed`)
- `readyz` failures

## Backups

The only data tsmyadmin keeps is the session store (`data/sessions.sqlite`). Losing the sessions only means signing in again, but with `SESSION_STORE=sqlite` the saved queries are in that same file — to keep those, copy the file (along with its `-wal` and `-shm`) with the process stopped. It is encrypted, so restoring it needs the same `SESSION_SECRET`. Everything else worth backing up is in the target databases. The export feature is not a substitute for operational backups: it is not a consistent snapshot.
