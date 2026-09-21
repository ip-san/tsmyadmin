<!-- translated-from: docs/dev-environment.md sha256:eb1d9714a32e5e83606014c8a8df56007ae9b6c587d52101a132633011441e3d -->

# Development features: what was built, and what was set aside

*日本語版: [docs/dev-environment.md](../dev-environment.md)*

tsmyadmin's core for development is opening the MySQL / PostgreSQL running in your local Docker in the browser without writing their addresses down ([deployment.md](deployment.md#using-it-for-development-with-docker-container-discovery)). This page records what was added on top of that for development, what was considered and set aside, and what comes next, with the reasons. Usage is in [user-guide.md](user-guide.md); [deployment.md](deployment.md) is the only source for environment variables.

## How this differs from phpMyAdmin

phpMyAdmin is for MySQL / MariaDB only, and you name the server in `config.inc.php` or an environment variable such as `PMA_HOST`. It does have a server dropdown on the login screen (with several servers configured), but that list is a fixed one you wrote. It has no discovery of Docker containers, and no PostgreSQL support. What tsmyadmin does differently is not the dropdown but that **the list fills itself from Docker without your writing it**, and that **PostgreSQL is on the same screen**.

## What was built

| Feature | Where | In short |
|---|---|---|
| **Statements as they run** | Server → Monitor | Streams the SQL the application under development is running now. MySQL / MariaDB: the general log (a table), newest first. PostgreSQL: the statements whose call count grew in `pg_stat_statements`, per read. This tool's own statements are left out. The MySQL general log can be turned on after you review the SQL |
| **Snapshots** | Database → Snapshots | Saves the database as it is (structure, data, views, routines, triggers) so that after trying a migration or a seed you can put it back. A snapshot is the existing SQL export and a restore runs that SQL, the same on both dialects. Before a restore you review the SQL that drops the tables and views made since. PostgreSQL does it in one transaction. Held in memory (gone when it restarts), per account |
| **One-click login** | Login screen | With `TSMYADMIN_DOCKER_LOGIN=1` (off by default), reads a container's login from its environment (`MYSQL_ROOT_PASSWORD`, `POSTGRES_PASSWORD`, …) inside the API process only and signs in without a password. Never sent to the browser, logged or stored. Anyone who can reach the tool can then get in, so publish it on `127.0.0.1` only |
| **Why a database is missing** | Login screen | Shows the database containers left off the list (stopped, port not published), why Docker cannot be read, and listed ports this process cannot reach, each with how to fix it |

## Considered and set aside

- **An MCP server (on hold)**: for a client that has Bash, such as Claude Code, `docker exec … psql` and reading the migration files cover most of it. The real advantages of MCP are two: it can *enforce* "read-only" in the implementation (with Bash, allowing `docker exec` allows a DROP after it), and it works in clients without Bash (Claude Desktop, say). Both can wait until they are needed. A cheaper way is to write the connection commands in CLAUDE.md or a Skill.
- **Making zero-click login the development default**: it stays off even for `bun run dev` and `docker-compose.dev.yml`. Anyone who can reach the tool could then open the databases without a password, so it is an explicit choice (`docker-compose.dev.yml` has the line to turn it on, commented out).
- **Persisting snapshots**: they are kept in memory so as not to add an environment variable or put data on disk in the clear. They are lost on restart. If needed, saving to disk can be added as a separate choice.
- **A real-time PostgreSQL stream**: `pg_stat_statements` is aggregated, normalised statements rather than a timeline of executions, and turning it on needs `shared_preload_libraries` and a restart (tsmyadmin issues only GET requests to Docker, so it cannot do that for you). So it shows the growth in call counts per read, and when the extension is unavailable it gives the steps to enable it in Docker.

## Next candidates (not built)

Ordered by how much they ease getting started and everyday troubleshooting.

1. **Detailed login errors in development only**: in production the server's own wording is replaced by a generic error so as not to hand out the API's egress address. In development it could tell apart MySQL's host restriction (`root@'172.x'` is refused), PostgreSQL's `pg_hba.conf` and a wrong password, and say how to fix each.
2. **Copy the connection info for the application**: for each discovered container, the address as seen from the host and as seen from another container (`host.docker.internal` or the compose service name), a `DATABASE_URL`, and `.env` lines.
3. **Lock waits and too many connections**: show in one screen which query is making whom wait, and end the blocking one in a click (`performance_schema` on MySQL, `pg_locks` on PostgreSQL).
4. **Wait for a container to start**: a container that starts later shows up without reopening the login screen, and one that is still starting is marked.
5. **Snapshots and a schema diff**: show what changed across a migration as DDL.

## Known limits

- **Initial JS budget**: about 159 kB of the 160 kB is used (`bun run size`). The next feature would exceed it. Splitting the Japanese / English strings (the locales) per screen is the likely fix.
- **A real PostgreSQL test**: the test compose has no `pg_stat_statements`, so the PostgreSQL path of "statements as they run" has been checked only in a throwaway container with the extension. Putting it in CI needs a change to the compose command and the fixtures (and a `db:reset`).
- **Leaving out "its own statements" is per connection** on MySQL: a second tsmyadmin session on the same server shows up as application traffic.
