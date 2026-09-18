<!-- translated-from: docs/security.md sha256:17e8abe724bd61dbbaadae639c94cde7ee438fc70afea8940177ef5149377784 -->

# Security model

*日本語版: [docs/security.md](../security.md)*

## Assumptions

- tsmyadmin is **a tool for someone who already holds database credentials to run arbitrary SQL within the privileges those credentials carry**. As in phpMyAdmin, restricting SQL in the application is not one of its goals. What it does protect is that nobody without credentials can use it, that it cannot be turned into a jump host to somewhere unintended, and that values make the round trip losslessly and safely
- Restrict who can reach it at the network level (a VPN, an internal network, IP restrictions, an SSO proxy). It is not meant to be published directly on the internet

## Authentication and sessions

- Every stored row is encrypted against that row (its `table:row id` goes into AES-GCM's additional authenticated data). Someone able to write the file but not to decrypt it therefore cannot copy another row's ciphertext over their own and have their session run with the victim's credentials; a row that will not open is discarded when it is read.
- Credentials are held server-side only; the browser gets nothing but **a cookie with a signed session ID** (`HttpOnly`, `SameSite=Strict`, and `Secure` in production). With `SESSION_STORE=sqlite`, the production default, credentials are stored AES-256-GCM encrypted under a key derived from `SESSION_SECRET` with HKDF — the file alone cannot be decrypted, so guard `SESSION_SECRET` as the environment secret it is
- A session expires after `SESSION_TTL_MINUTES` of inactivity; signing out or expiring closes its database connection pool
- Passwords appear in no API response (`GET /api/session`), no log, no account-operation preview or result, and no database error message — they are masked as `****`. A password typed straight into the SQL console (`IDENTIFIED BY '…'`, `PASSWORD '…'`, `SET PASSWORD … = '…'`) is masked before the audit log is written: comments are stripped first, and in a statement containing `IDENTIFIED` or `PASSWORD` everything from the first quote after the keyword to the last quote becomes a single mask, so no fragment survives even when the statement was passed as a string to `PREPARE` / `EXECUTE` / `format()` or contains a nested `''`. `*_PASSWORD` variants such as `SOURCE_PASSWORD`, a `password=…` inside a connection string, and an `AS 0x…` hash are covered too. (The summary is not meant to be re-run, so comments are lost.)
- An unexpected internal error is returned to the client as `INTERNAL` and nothing else; the message and stack stay in the server log
- Request body limits: 64 KB for `/api/session`, 16 MB for running SQL, `IMPORT_MAX_BYTES` (64 MB) for imports, and 1 MB for other JSON. Over the limit is `413 PAYLOAD_TOO_LARGE` (for an import, both a file past 64 MB and a multipart body past 65 MB)

## Two-factor authentication (TOTP and passkeys)

- Each database account that logs in can add a one-time code from an authenticator app (the **Security** tab). The secret and the hashes of the recovery codes are encrypted with the same key as the credentials and kept in the session store (one row per account, unrelated to the saved-item cap), so `SESSION_STORE=sqlite` or `redis` is required
- **What it protects**: in this product the database credentials *are* the identity, so whoever knows the password can also enrol first. A second factor helps once it is enrolled — against a password that leaks later (reuse, shoulder-surfing, a dump). `TSMYADMIN_REQUIRE_2FA=1` closes that window: an account that has not enrolled can do nothing until it has
- A code that has been accepted cannot be used again, even within its own 30 seconds (the accepted step is recorded). Each recovery code works once. Code attempts count against the same per-IP budget as failed logins
- Removing it takes a current code from the app, and so does replacing an enrolled secret with a new one — otherwise that check could simply be walked around
- **A lost device**: use a recovery code, or reset it from the **Users** tab as an account that could change that account's password (MySQL: `CREATE USER`, plus `SYSTEM_USER` on MySQL 8; PostgreSQL: a superuser, or `CREATEROLE` over that role). It only reaches accounts the database already lets it take over, so nothing is weakened. An account cannot reset its own there (that goes through the security tab, with a code). Each reset is logged as `second_factor.reset`. On MySQL 8, whether the target holds `SYSTEM_USER` is not visible to everyone, so an operator without `SYSTEM_USER` is not offered the reset at all, even for accounts that lack it (erring on the safe side). It reaches accounts enrolled through the same address (host name and port). As a last resort the stored factors can be deleted directly (`DELETE FROM second_factor;` on `sqlite`, `DEL <prefix>:2fa:*` on `redis` — that removes everyone's). Rotating `SESSION_SECRET` wipes every enrolment, so that a row nobody can read never locks an account out
- **Passkeys (WebAuthn)**: with `TSMYADMIN_PASSKEY_ORIGIN` set, a passkey can be the second factor instead of (or next to) an authenticator app. It does not replace the password — connecting to the database needs the password itself. Verification is left to `@simplewebauthn/server`, which checks the origin and host name, the signature and the challenge the server handed out. A challenge expires after two minutes and can be answered once. At login it is handed out only after the password has been accepted, and is tied to that account, so nobody without the password even learns who has a passkey. Where the authenticator keeps a signature counter, an answer that does not move it forward (a cloned authenticator, say) is refused. A passkey is bound to the host name, so moving the deployment to another domain leaves the enrolled ones unusable (a recovery code, or an operator's reset, gets the account back)
- Adding or removing a method, or turning it all off, takes proof with a method already there (a current code from the app, or an enrolled passkey). A recovery code is not proof — it is for getting in. Removing the last method turns two-factor off, recovery codes included
- The QR code shown at enrolment is made inside the server, and the page only draws its grid of modules as shapes: the secret never goes to an outside QR service
- The code field is `autocomplete="one-time-code"` so a password manager can fill it. Codes are never stored or logged

## Restricting where it connects (SSRF and jump-host protection)

The login screen can name only the database hosts listed in `TSMYADMIN_ALLOWED_HOSTS`. The default is local only; use `*` in development only. A connection to a host or port that is not allowed is refused with `403 HOST_NOT_ALLOWED` before any database is touched, and recorded as `login.host_not_allowed`.

An entry is `host[:port]` (`db.internal:5432`, `[::1]:3306`, `*.rds.amazonaws.com:5432`). **Name the port in production**: an entry without one allows every port on that host, which lets an unauthenticated login request tell "connected" from "authentication failed" and so use the service as a port scanner against whatever else listens on an allowed host. In production (`NODE_ENV=production`), an entry without a port warns at startup as `config.allowlist_without_port`. A server preset (`TSMYADMIN_SERVERS`) automatically allows that preset's `host:port` and nothing more.

## Brute-force protection

`POST /api/session` is limited to `LOGIN_RATE_LIMIT` attempts per `LOGIN_RATE_WINDOW_SECONDS`, counted per client IP and username. (The client IP is the socket address by default. With `TRUST_PROXY=1` the **last** element of `X-Forwarded-For` is used — the one a trusted proxy appended, since the front of the list is whatever the client wrote. `TRUST_PROXY=cloudflare` prefers `CF-Connecting-IP` and falls back to the `1` behaviour when that header is absent. Headers such as `X-Real-IP` are never trusted under any setting.) Going over is `429 RATE_LIMITED`, with `Retry-After`. A successful sign-in resets the counter. To stop someone cycling through usernames, there is a second limit per IP of `LOGIN_RATE_LIMIT × 3` **failures** in the same window; successful sign-ins are not counted, so legitimate users behind a shared NAT are not locked out. Attempts against a host that is not on the allowlist count here too, since the difference between `403` and `401` reveals which hosts exist. One consequence: a stale connection preset behind a shared NAT can push colleagues into `429` on hosts that are perfectly valid.

The session cookie's `Max-Age` is reissued on every authenticated request, keeping it in step with the sliding server-side TTL.

## Capping connections (protecting the database's `max_connections`)

Each sign-in creates a session, and so a connection pool. On top of that, cancelling a running query opens one dedicated connection (concurrent cancels of the same run share it; the pool size is the ceiling, so at most +4 per session). One database account holds at most `SESSION_MAX_PER_IDENTITY` sessions (10 by default), and beyond that the least recently used are closed — including the earlier session of a browser that signed in again without signing out. The formula for sizing `max_connections` is under *Sizes and limits* in [deployment.md](deployment.md).

## About the SQL console's row limit

**Row limit** exists so a slip (`SELECT * FROM a_huge_table`) cannot exhaust the API's memory; it is not a restriction on the account itself. It is implemented with `sql_select_limit` on MySQL and MariaDB, and with a `LIMIT` on a derived table on PostgreSQL, so a `LIMIT` written in the statement is honoured as it is (a statement whose own `LIMIT` exceeds the cap is wrapped in a derived table again). Running `SET SESSION sql_select_limit` inside a script does not get around it: the cap is reapplied after that statement. The exception is a statement that cannot be wrapped in a derived table (`FOR UPDATE`, `LOCK IN SHARE MODE`, `INTO`, or `SQL_CALC_FOUND_ROWS`, which MySQL refuses to wrap): a large `LIMIT` there takes effect as written.

## The `DEFINER` clause in exports

**Strip the DEFINER clause** in a SQL export makes the restoring account the definer of the views, routines and triggers that come back. An object with `SQL SECURITY DEFINER` then runs with that account's privileges, so read what you are restoring if the restoring account is stronger than the original definer (the same trade-off as mysqldump's `--skip-definer`).

## What stays in the browser

Credentials stay on the server, but for convenience the following is kept in **that browser's `localStorage`**. None of it is masked or encrypted.

| What is kept | Contents |
|---|---|
| SQL history | The last 100 statements run, per server. A statement containing a password (`CREATE USER … IDENTIFIED BY 'x'`) is kept **as it is** (the audit log masks it as `****`) |
| Saved queries | SQL the user saved under a name. Kept here only with `SESSION_STORE=memory`; with `sqlite`, the production default, it is stored on the server encrypted under the same key as the credentials and nothing stays in the browser |
| The last server signed in to | Dialect, host, port, username and database (**never the password**) |
| Display settings | Language, theme, whether the sidebar is open, rows per page, and so on |

On a shared machine, run **Clear history** in the SQL tab and sign out before you leave. `localStorage` is never sent to the server, so tsmyadmin cannot clear it for you.

## If `SESSION_SECRET` leaks

1. Set a new value (`openssl rand -hex 32`) and restart. Startup detects that the key fingerprint changed, deletes every stored session row (logged as `session_store.reset`) and invalidates the cookie signatures, so everyone signs in again (saved queries, export templates and every second-factor enrolment go with them). (Step 1 is needed with `SESSION_STORE=memory` too, since it is also the signing key.)
2. If `data/sessions.sqlite` (and its `-wal` / `-shm` files) may have leaked at the same time, the credentials inside it can be decrypted: change the database passwords of every `user@host` recorded in `login.ok` during the exposure
3. The logs never contain a raw session ID (`sessionId` is the first 16 characters of a hash). Even so, treat access to the logs as you treat access to the secrets

## CSRF and XSS

- On top of the `SameSite=Strict` cookie, form (multipart) POSTs are protected by `Origin` validation (`hono/csrf`). The JSON API cannot be called from another site because of the browser's cross-origin rules (CORS is not granted)
- `Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'none'` and the rest (`CONTENT_SECURITY_POLICY` in `apps/api/src/app.ts`). Inline script is not allowed; only `style-src 'unsafe-inline'` is, because CodeMirror needs it
- Every value is rendered through React (`dangerouslySetInnerHTML` is never used)

## How SQL is built

- Identifiers are always quoted (`quoteIdent`) and values are always placeholders. SQL may be assembled by string interpolation only inside a few builders in the adapter, and `bun run check:sql-safety` enforces that in CI
- DDL and account operations show the generated SQL first and run only after the user explicitly confirms it
- Updating and deleting rows verifies "affected rows = 1" inside a transaction and rolls back otherwise

## Auditing

The structured log (`LOG_FORMAT=json`) carries `login.ok`, `login.failed`, `login.host_not_allowed`, `login.rate_limited` and `logout`, plus an access log with request IDs. Every call that changes something is recorded in the audit log at the adapter boundary (`event: audit`): who, against which database, what (row values are never included; a SQL console statement is recorded to its first 500 characters, so it can contain values; an import records only `<import>` and the length of the script) and whether it succeeded. See [operations.md](operations.md).

## Supply chain

- GitHub Actions are pinned by commit SHA (`.github/workflows/ci.yml`, with the tag in a comment beside it), and Dependabot (`.github/dependabot.yml`) opens monthly update PRs for both the actions and the `bun.lock` dependencies
- Dependencies are pinned by `bun.lock`, and the production image is built with `bun install --production --ignore-scripts`, so no postinstall script runs

## Known limitations

- The session store is a SQLite file, so several replicas cannot share it (sticky sessions are required)
- MySQL's `DELIMITER xx` is recognised only when it stands alone at the start of a line (matching the mysql client)
- The database's own user privileges are the only access control; tsmyadmin has no roles of its own. A missing privilege is reported distinctly as `PERMISSION_DENIED` (403) — see [operations.md](operations.md)
