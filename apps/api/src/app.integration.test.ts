/** API against the real compose databases (bun run test:integration). */
import { createAdapter } from '@tsmyadmin/adapter'
import { ApiErrorSchema, SessionStateSchema, StatementResultSchema } from '@tsmyadmin/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { MemorySessionStore } from './session/store.ts'
import type { IntegrationContext } from './test/integration/context.ts'
import { describeDumpAndSnapshot } from './test/integration/dump-and-snapshot.ts'
import { describeImport } from './test/integration/import.ts'
import { describeRoutinesAndCopy } from './test/integration/routines-and-copy.ts'

const targets = [
  {
    dialect: 'mysql' as const,
    url: process.env.TEST_MYSQL_URL ?? 'mysql://tsmyadmin:tsmyadmin@127.0.0.1:13306/tsmyadmin_test',
  },
  {
    dialect: 'postgres' as const,
    url: process.env.TEST_PG_URL ?? 'postgres://tsmyadmin:tsmyadmin@127.0.0.1:15433/tsmyadmin_test',
  },
  // TEST_DIALECTS=mysql restricts the run to one server (the MariaDB CI job has no PostgreSQL service).
].filter((t) => !process.env.TEST_DIALECTS || process.env.TEST_DIALECTS.split(',').includes(t.dialect))

const store = new MemorySessionStore({ adapterFactory: createAdapter, sweepIntervalMs: 0 })
const app = createApp({ ...loadConfig({}), sessionSecret: 'integration-secret', allowedHosts: ['*'] }, { store })
afterAll(() => store.closeAll())

describe.each(targets)('API integration ($dialect)', ({ dialect, url }) => {
  const u = new URL(url)
  const login = {
    dialect,
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  }
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } })

  it('logs in against the real server', async () => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify(login) })
    expect(res.status).toBe(201)
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(SessionStateSchema.parse(await res.json()).dialect).toBe(dialect)
  })

  it('refuses to rename a MySQL database that has a view, trigger, routine or event, on the real server', async () => {
    if (dialect !== 'mysql') return
    const name = `it_dbops_${Date.now().toString(36)}`
    const run = (sql: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql, stopOnError: true }) })
    await run(`CREATE DATABASE ${name}`)
    try {
      await run(
        [
          `CREATE TABLE ${name}.t (id INT PRIMARY KEY)`,
          `CREATE VIEW ${name}.v AS SELECT id FROM ${name}.t`,
          `CREATE TRIGGER ${name}.trg BEFORE INSERT ON ${name}.t FOR EACH ROW SET NEW.id = NEW.id`,
          `CREATE PROCEDURE ${name}.p() SELECT 1`,
          `CREATE EVENT ${name}.e ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1`,
        ].join(';\n')
      )
      const res = await req('/api/databases/information_schema/ddl/preview', {
        method: 'POST',
        body: JSON.stringify({ op: { op: 'renameDatabase', name, newName: `${name}_x` } }),
      })
      expect(res.status).toBe(400)
      const { message } = ApiErrorSchema.parse(await res.json())
      for (const what of ['1 views', '1 triggers', '1 routines', '1 events']) expect(message).toContain(what)
    } finally {
      await run(`DROP DATABASE IF EXISTS ${name}`)
    }
  })

  it('rejects wrong passwords', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, password: 'nope' }),
    })
    expect(res.status).toBe(401)
  })

  it('connects in the collation asked for (MySQL), and refuses a name that is not one', async () => {
    if (dialect !== 'mysql') return
    const asked = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, collation: 'utf8mb4_bin' }),
    })
    expect(asked.status).toBe(201)
    const own = asked.headers.get('set-cookie')?.split(';')[0] ?? ''
    const ran = await app.request('/api/databases/tsmyadmin_test/sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: own },
      body: JSON.stringify({ sql: 'SELECT @@collation_connection AS c' }),
    })
    const [result] = z.array(StatementResultSchema).parse(await ran.json())
    expect(result?.kind === 'rows' ? result.result.rows : null).toEqual([['utf8mb4_bin']])
    const bad = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, collation: 'x; y' }),
    })
    expect(bad.status).toBe(400)
  })

  const c: IntegrationContext = {
    dialect,
    req,
    app,
    get cookie() {
      return cookie
    },
  }
  // The groups run here, between the first test (which logs in) and the last (which logs out), in their old order.
  describeDumpAndSnapshot(c)
  describeRoutinesAndCopy(c)
  describeImport(c)

  it('reports whether a failed account operation was rolled back', async () => {
    // Granting to an account that does not exist fails on both servers. PostgreSQL runs a multi-statement
    // operation in one transaction, so the response reports the rollback; MySQL commits each statement as it runs.
    const user = dialect === 'mysql' ? { name: 'r_optx_missing', host: '%' } : { name: 'r_optx_missing' }
    const res = await req('/api/users/execute', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'grantAll', user, database: 'tsmyadmin_test' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { kind: string }[]; rolledBack: boolean }
    expect(body.results.some((r) => r.kind === 'error')).toBe(true)
    expect(body.rolledBack).toBe(dialect === 'postgres')
  })

  it('logs out', async () => {
    expect((await req('/api/session', { method: 'DELETE' })).status).toBe(200)
  })
})
