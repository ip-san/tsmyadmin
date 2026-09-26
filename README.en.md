<!-- translated-from: README.md sha256:4faefe094f319bdd84c2b7e40e1aca83abec0f210bec1e33f3a474d1379f02fc -->

# tsmyadmin

*日本語版: [README.md](README.md) · [GitHub](https://github.com/ip-san/tsmyadmin)*

A web-based database admin tool that opens the MySQL / PostgreSQL databases running in your local Docker from the browser, with no connection settings to write. The layout follows phpMyAdmin, and it is written in TypeScript. MySQL, MariaDB and PostgreSQL share the same screens.

The databases each of your projects started with `docker compose up` show up in a list on the login screen. Pick one and you are in, without looking up hostnames or ports and writing them into a config.

## Quick start (development)

All you need is Docker.

```bash
git clone https://github.com/ip-san/tsmyadmin.git && cd tsmyadmin
docker compose -f docker-compose.dev.yml up -d --build
```

Open <http://localhost:3100>. The MySQL / MariaDB / PostgreSQL containers running in Docker right now are listed on the login screen as `docker: project/service`. Pick one and enter that project's username and password.

- The databases your other projects started with `docker compose up` are found automatically through the ports they publish on the host. One started later shows up when you open the login screen again
- By default all it reads is the container list and the database names. Passwords are never read or stored
- It is for development only. It needs the Docker socket (root on the host), so it refuses to start with `NODE_ENV=production`. How it works and what to watch (published ports on Linux, the socket's permissions) is in [docs/en/deployment.md](docs/en/deployment.md#using-it-for-development-with-docker-container-discovery)
- To offer fixed targets, or to deploy it, use server presets and the allowlist ([docs/en/deployment.md](docs/en/deployment.md#environment-variables-the-only-list))

## Features for development

Beyond Docker discovery, there are features for watching what your application does to the database, and for going back after trying something.

- **Executed statements (live)**: see the SQL your application is running right now in the server's "Monitor" tab. MySQL / MariaDB stream the general log newest first; PostgreSQL shows which statements in `pg_stat_statements` gained calls since the last read
- **Snapshots**: save the current state of a database (structure, data, views, routines, triggers) and go back to it after trying a migration or a seed. Snapshots live in the API's memory and are gone after a restart
- **Diagnosis when a target is missing or unreachable**: database containers that are not listed (stopped, no published port) and the reasons Docker could not be read are shown on the login screen, with how to fix them
- **One-click login**: only when you set `TSMYADMIN_DOCKER_LOGIN=1` does it read a container's credentials from its environment, inside the API process, to sign in in one click with no password. The password is never sent to the browser, logged or stored. It is off by default. Once it is on, anyone who can reach the tool can open those databases, so publish it on `127.0.0.1` only

What was built and what was set aside is written up in [docs/en/dev-environment.md](docs/en/dev-environment.md).

## Features

Supported: **MySQL 8.0–9**, **MariaDB 10.11 (LTS) / 11**, **Percona Server 8.4** and **PostgreSQL 14–18**. Which versions CI verifies, which are verified by hand, and the measured results for the compatible engines TiDB and CockroachDB are in [docs/en/deployment.md](docs/en/deployment.md#supported-databases). The interface is available in English and Japanese; it follows the browser's language setting and can be switched at the top right.

**The layout is the same three levels as phpMyAdmin.** Server (Databases / SQL / Status / Variables / Processes / Users) → database (Structure / SQL / Export / Import / Privileges / Routines / Triggers / Events) → table (Browse / Structure / SQL / Search / Insert / Export / Import / Triggers / Operations).

- Connecting: Docker container discovery (for development), server presets defined by the administrator, cookie sessions, two-factor authentication (one-time codes from an authenticator app, passkeys)
- Viewing: a tree of databases / schemas / tables, browsing rows (sorting, paging, filtering, choosing which columns to show, links from a foreign key to the row it references and back)
- Editing: inserting rows (with insert-again and duplicate), editing them (in a dialog or in place), deleting them
- SQL console: CodeMirror, several statements at once, MySQL `DELIMITER`, per-statement results streamed as each one finishes, EXPLAIN, history and saved queries, CSV / JSON download of the result, cancelling a run
- DDL: creating, renaming and copying tables; adding, changing and dropping columns; adding and dropping indexes and foreign keys; TRUNCATE and DROP; creating and dropping databases; creating schemas. Anything that cannot be undone is confirmed by retyping the name
- Export / import: SQL / CSV / JSON, and loading SQL scripts and CSV files
- Accounts: listing, showing privileges, creating, changing passwords, dropping; GRANT and REVOKE ALL per database
- Server: status, variables, the process list (with KILL), stored procedures / functions / triggers with their definitions, the MySQL event scheduler (listing, enabling / disabling, dropping)
- Keyboard shortcuts (`?` lists them)

**It errs on the safe side.** Every DDL and account operation shows the generated SQL for review before it runs (passwords are masked). Each run in the SQL console is autocommitted, and a transaction left open is rolled back before the connection returns to the pool.

**Values are shown without loss.** BIGINT, DECIMAL, date-time values and JSON stay exactly as the server returned them, binary is shown as base64, and NULL and the empty string stay distinct.

## In production (optional)

Development is what it is built for first, but it also has the safeguards for production (a host allowlist, login rate limiting, a CSP, an audit log, an encrypted session store).

```bash
docker build -t tsmyadmin .
docker run -d --name tsmyadmin \
  -p 127.0.0.1:3100:3100 \
  --stop-timeout 35 \
  -v tsmyadmin-data:/app/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e TSMYADMIN_ALLOWED_HOSTS=db.example.internal:5432 \
  tsmyadmin
```

A single container, with the API serving the SPA. You must list the `host:port` of every database you want to reach in `TSMYADMIN_ALLOWED_HOSTS`. The default is the container's own loopback, so without it nothing can be connected to. In production, put it behind a reverse proxy that terminates HTTPS. To run several replicas, `SESSION_STORE=redis` shares the sessions between them (see [docs/en/deployment.md](docs/en/deployment.md#several-replicas) for what is shared and what is not).

## Developing this repository

You need **Bun 1.4 or newer** (CI uses 1.4.0), **Docker** (Compose v2; `db:up` uses `docker compose up --wait`) and **Node** (the check scripts such as `bun run check` run on Node). No `.env` is required. Sessions are in memory and the allowed hosts are `127.0.0.1,localhost` by default (the variables are listed in `.env.example` and [docs/en/deployment.md](docs/en/deployment.md)).

```bash
bun install
bun run db:up      # docker compose: MySQL 8.4 (localhost:13306) + PostgreSQL 17 (localhost:15433), fixtures loaded automatically
bun run dev        # API http://localhost:3100 + web http://localhost:5175
```

`bun run dev` has Docker discovery on by default, so the login screen lists the database containers that are running. Turn it off with `TSMYADMIN_DOCKER_DISCOVERY=0 bun run dev`.

To sign in to the test databases: MySQL `127.0.0.1:13306` or PostgreSQL `127.0.0.1:15433`, user `tsmyadmin`, password `tsmyadmin`, database `tsmyadmin_test`.

The repository is a Bun workspaces monorepo: `apps/api` (Hono) / `apps/web` (Vite + React 19 + TanStack Router/Query) / `packages/shared` (Zod DTOs) / `packages/adapter` (a thin database abstraction over `mysql2` and `pg`; no ORM).

## Quality gates

```bash
bun run check            # typecheck + lint + unit/API/web tests + type-coverage
bun run check:static     # check + knip / circular imports / clones / architecture / SQL safety / docs (runs on pre-push)
bun run check:all        # check:static + the integration tests against both databases
bun run test:e2e         # Playwright (Chromium / WebKit functional, axe a11y, VRT light+dark). Run db:up first
bun run lighthouse       # Lighthouse CI (performance / a11y / best practices on the login screen; warnings only, needs Chrome)
```

- The E2E suite needs `bunx playwright install --with-deps chromium webkit` once
- The VRT baseline images exist for macOS only (`*-darwin.png`), so on another OS use what CI uses: `bunx playwright test --project=chromium --project=a11y --project=webkit`
- `bun run lighthouse` looks at the production build, so run `bun run build` first

The project's own checks:

- `scripts/check-architecture.mjs`: layer dependencies (the web app never touches a database driver, routes go through the adapter, features do not import each other) and component length
- `scripts/check-sql-safety.mjs`: that no SQL is built by interpolation or concatenation outside the adapter's builders, and that no identifier is quoted by hand
- `scripts/validate-docs.mjs`: that the statistics in `CLAUDE.md` match reality (`--fix`), and that the port the Cloudflare worker forwards to matches `EXPOSE` in the `Dockerfile`
- `scripts/check-contrast.mjs`: that every combination of the design tokens meets the WCAG contrast ratios (with a `--self-test`). axe judges text only, and only the combinations a test happens to render, so this is checked separately
- `scripts/check-translations.mjs`: that each English document has been updated for the Japanese original it was written from (with a `--self-test`; `bun run docs:sync` stamps them after translating)

`packages/adapter/src/test/conformance.ts` runs one suite against both MySQL and PostgreSQL, which is what guarantees the dialect differences are actually absorbed.

## Documentation

The Japanese files are the originals; `bun run docs:i18n` checks that the English ones keep up.

**For users**

- [docs/en/user-guide.md](docs/en/user-guide.md): the screens and how to work with them, how values are shown, the limits
- [docs/en/dev-environment.md](docs/en/dev-environment.md): the features for development (executed statements, snapshots, one-click login, diagnosis), what was set aside, what comes next, known limits
- [docs/en/phpmyadmin-parity.md](docs/en/phpmyadmin-parity.md): feature parity with phpMyAdmin (what is still different, and what will not be built and why)

**For running it**

- [docs/en/deployment.md](docs/en/deployment.md): the environment variables, Docker and compose examples, reverse proxies and TLS, supported databases, sizes and limits
- [docs/en/hosting.md](docs/en/hosting.md): where to run it (an ordinary server such as Sakura VPS, AWS, Azure), covering only what differs between them
- [docs/en/cloudflare.md](docs/en/cloudflare.md): setting up and deploying on Cloudflare Containers, why Workers cannot run it, and using Tunnel / Access as the front door only
- [docs/en/operations.md](docs/en/operations.md): health checks, log events, the error code table, troubleshooting, monitoring, backups
- [docs/en/security.md](docs/en/security.md): assumptions and trust boundary, authentication and sessions, the host allowlist, rate limiting, CSP, what stays in the browser

**For developing it**

- [docs/en/architecture.md](docs/en/architecture.md): the design as a whole, with Mermaid diagrams: package dependencies, the adapter layer, sessions and connection pools, the path of the main requests, export / import, the quality gates, and a where-is-it table
- [CLAUDE.md](CLAUDE.md): the development commands, the layout, and the invariants to preserve (Compact Instructions). These are the conventions for human developers too (Japanese)
- [CHANGELOG.md](CHANGELOG.md): the release notes (Japanese)
- `.claude/rules/`: the detailed per-path rules (adapter / api-routes / fixtures / skill-scoping)
- `.claude/agents/`, `.claude/skills/`: the quality-gate / code-reviewer / test-developer agents and the `/self-review`, `/quality-loop` and `/docs-polish` skills

## Requirements

- Server: Bun 1.4 or newer (bundled in the Docker image). For the database versions supported and how each is verified, see [docs/en/deployment.md](docs/en/deployment.md#supported-databases)
- Browser: a current Chrome, Edge, Firefox or Safari (ES2022, `<dialog>` and `dvh` units are required)

## Licence

MIT ([LICENSE](LICENSE))

tsmyadmin takes its features and screen layout from phpMyAdmin (GPL), but contains none of its code, translations or images: everything is implemented independently. It is a separate tool and is not affiliated with phpMyAdmin.
