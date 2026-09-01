/** API against the real compose databases (bun run test:integration). */
import { createAdapter } from '@tsmyadmin/adapter'
import { BrowseResultSchema, SessionInfoSchema, StatementResultSchema, TableSchemaSchema } from '@tsmyadmin/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { MemorySessionStore } from './session/store.ts'

const targets = [
  {
    dialect: 'mysql' as const,
    url: process.env.TEST_MYSQL_URL ?? 'mysql://tsmyadmin:tsmyadmin@127.0.0.1:13306/tsmyadmin_test',
  },
  {
    dialect: 'postgres' as const,
    url: process.env.TEST_PG_URL ?? 'postgres://tsmyadmin:tsmyadmin@127.0.0.1:15433/tsmyadmin_test',
  },
]

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
    expect(SessionInfoSchema.parse(await res.json()).dialect).toBe(dialect)
  })

  it('rejects wrong passwords', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, password: 'nope' }),
    })
    expect(res.status).toBe(401)
  })

  it('walks databases → tables → structure → rows', async () => {
    const dbs = z.array(z.object({ name: z.string() })).parse(await (await req('/api/databases')).json())
    expect(dbs.map((d) => d.name)).toContain('tsmyadmin_test')
    const tables = await (await req('/api/databases/tsmyadmin_test/tables')).json()
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(tables)
        .map((t) => t.name)
    ).toContain('users')
    const structure = TableSchemaSchema.parse(
      await (await req('/api/databases/tsmyadmin_test/tables/users/structure')).json()
    )
    expect(structure.primaryKey).toEqual(['id'])
    const rows = BrowseResultSchema.parse(
      await (await req('/api/databases/tsmyadmin_test/tables/users/rows?sort=name:desc&limit=2')).json()
    )
    expect(rows.rows.map((r) => r[1])).toEqual(['Eve', 'Dave'])
    expect(rows.total).toBe(5)
  })

  it('runs SQL and previews DDL', async () => {
    const results = z.array(StatementResultSchema).parse(
      await (
        await req('/api/databases/tsmyadmin_test/sql', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM users' }),
        })
      ).json()
    )
    expect(results[0]?.kind).toBe('rows')
    const preview = await (
      await req('/api/databases/tsmyadmin_test/ddl/preview', {
        method: 'POST',
        body: JSON.stringify({ op: { op: 'dropTable', table: 'users' } }),
      })
    ).json()
    expect(z.object({ sql: z.array(z.string()) }).parse(preview).sql[0]).toMatch(/DROP TABLE/)
  })

  it('logs out', async () => {
    expect((await req('/api/session', { method: 'DELETE' })).status).toBe(200)
  })
})
