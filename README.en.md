<!-- translated-from: README.md sha256:dc5a28274b3cf042f38ab19340a05edb82a750c26d16feaa54225a34c43d1d5f -->

# tsmyadmin

*日本語版: [README.md](README.md)*

A modern TypeScript phpMyAdmin clone, for MySQL and PostgreSQL alike.

The interface is available in English and Japanese (it follows the browser's language setting and can be switched at the top right). Supported: **MySQL 8.0–9**, **MariaDB 10.11 (LTS) / 11**, **Percona Server 8.4**, **PostgreSQL 14–18**. MySQL 8.0 / 8.4, MariaDB 10.11 / 11 and PostgreSQL 14 / 17 are verified on every CI run; MySQL 9, PostgreSQL 18 and Percona are verified by hand. For the details — including measured results for the compatible engines TiDB and CockroachDB — see [docs/en/deployment.md](docs/en/deployment.md#supported-databases).

- **A Bun workspaces monorepo**: `apps/api` (Hono) / `apps/web` (Vite + React 19 + TanStack Router/Query) / `packages/shared` (Zod DTOs) / `packages/adapter` (a thin database abstraction over `mysql2` and `pg`; no ORM)
- **The same layout as phpMyAdmin**: server (Databases / SQL / Status / Variables / Processes / Users) → database (Structure / SQL / Export / Import / Privileges / Routines / Triggers / Events) → table (Browse / Structure / SQL / Search / Insert / Export / Import / Triggers / Operations)
- **Features**
  - Connecting: server presets defined by the administrator, cookie sessions
  - Viewing: a tree of databases / schemas / tables, browsing rows (sorting, paging, filtering, choosing which columns to show, links from a foreign key to the row it references and back)
  - Editing: inserting rows (with insert-again and duplicate), editing them (in a dialog or in place), deleting them
  - SQL console: CodeMirror, several statements at once, MySQL `DELIMITER`, per-statement results streamed as each one finishes, EXPLAIN, history and saved queries, CSV / JSON download of the result, cancelling a run
  - DDL: creating, renaming and copying tables; adding, changing and dropping columns; adding and dropping indexes and foreign keys; TRUNCATE and DROP; creating and dropping databases; creating schemas (anything that cannot be undone is confirmed by retyping the name)
  - Export / import: SQL / CSV / JSON, and loading SQL scripts and CSV files
  - Accounts: listing, showing privileges, creating, changing passwords, dropping; GRANT and REVOKE ALL per database
  - Server: status, variables, the process list (with KILL), stored procedures / functions / triggers with their definitions, the MySQL event scheduler (listing, enabling / disabling, dropping)
  - Keyboard shortcuts (`?` lists them)
- **Safe by construction**: every DDL and account operation shows the generated SQL for review before it runs (passwords are masked). Each run in the SQL console is autocommitted, and a transaction left open is rolled back before the connection returns to the pool
- **Lossless values**: BIGINT, DECIMAL, date-time values and JSON stay exactly as the server returned them; binary is base64; NULL and the empty string stay distinct

## Development

You need **Bun 1.4 or newer** (CI uses 1.4.0), **Docker** (Compose v2 — `db:up` uses `docker compose up --wait`) and **Node** (the check scripts such as `bun run check` run on Node). No `.env` is required: sessions are in memory and the allowed hosts are `127.0.0.1,localhost` by default (the variables are listed in `.env.example` and [docs/en/deployment.md](docs/en/deployment.md)).

```bash
bun install
bun run db:up      # docker compose: MySQL 8.4 (localhost:13306) + PostgreSQL 17 (localhost:15433), fixtures loaded automatically
bun run dev        # API http://localhost:3100 + web http://localhost:5175
```

To sign in to the test databases: MySQL `127.0.0.1:13306` or PostgreSQL `127.0.0.1:15433`, user `tsmyadmin`, password `tsmyadmin`, database `tsmyadmin_test`.

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

- `scripts/check-architecture.mjs` — layer dependencies (the web app never touches a database driver, routes go through the adapter, features do not import each other) and component length
- `scripts/check-sql-safety.mjs` — that no SQL is built by interpolation or concatenation outside the adapter's builders, and that no identifier is quoted by hand
- `scripts/validate-docs.mjs` — that the statistics in `CLAUDE.md` match reality (`--fix`)
- `scripts/check-translations.mjs` — that each English document has been updated for the Japanese original it was written from (with a `--self-test`; `bun run docs:sync` stamps them after translating)

`packages/adapter/src/test/conformance.ts` runs one suite against both MySQL and PostgreSQL, which is what guarantees the dialect differences are actually absorbed.

## Not implemented yet (what is next)

A session store that several replicas can share (Redis or similar).

## Production build

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

A single container, with the API serving the SPA. You **must** list the `host:port` of every database you want to reach in `TSMYADMIN_ALLOWED_HOSTS` — the default is the container's own loopback, so without it nothing can be connected to. In production, put it behind a reverse proxy that terminates HTTPS (see [docs/en/deployment.md](docs/en/deployment.md)).

## Documentation

**For users**

- [docs/en/user-guide.md](docs/en/user-guide.md) — the screens and how to work with them, how values are shown, the limits

**For running it**

- [docs/en/deployment.md](docs/en/deployment.md) — the environment variables, Docker and compose examples, reverse proxies and TLS, supported databases, sizes and limits
- [docs/en/operations.md](docs/en/operations.md) — health checks, log events, the error code table, troubleshooting, monitoring, backups
- [docs/en/security.md](docs/en/security.md) — assumptions and trust boundary, authentication and sessions, the host allowlist, rate limiting, CSP, what stays in the browser

**For developing it**

- [docs/en/architecture.md](docs/en/architecture.md) — the design as a whole, with Mermaid diagrams: package dependencies, the adapter layer, sessions and connection pools, the path of the main requests, export / import, the quality gates, and a where-is-it table
- [CLAUDE.md](CLAUDE.md) — the development commands, the layout, and the invariants to preserve (Compact Instructions). **These are the conventions for human developers too** (Japanese)
- [CHANGELOG.md](CHANGELOG.md) — the release notes (Japanese)
- `.claude/rules/` — the detailed per-path rules (adapter / api-routes / fixtures / skill-scoping)
- `.claude/agents/`, `.claude/skills/` — the quality-gate / code-reviewer / test-developer agents and the `/self-review` and `/quality-loop` skills

## Requirements

- Server: Bun 1.4 or newer (bundled in the Docker image). For the database versions supported and how each is verified, see [docs/en/deployment.md](docs/en/deployment.md#supported-databases)
- Browser: a current Chrome, Edge, Firefox or Safari (ES2022, `<dialog>` and `dvh` units are required)

## Licence

MIT ([LICENSE](LICENSE))
