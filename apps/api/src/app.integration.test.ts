/** API against the real compose databases (bun run test:integration). */
import { createAdapter } from '@tsmyadmin/adapter'
import { BrowseResultSchema, SessionStateSchema, StatementResultSchema, TableSchemaSchema } from '@tsmyadmin/shared'
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
    expect(SessionStateSchema.parse(await res.json()).dialect).toBe(dialect)
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

  it('produces a SQL dump that restores over the existing objects (foreign keys after all tables)', async () => {
    const parent = `dump_parent_${dialect}`
    const child = `dump_child_${dialect}`
    const sql = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
    await sql(
      `CREATE TABLE ${parent} (id INT PRIMARY KEY);
       CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id INT NULL, CONSTRAINT ${child}_fk FOREIGN KEY (parent_id) REFERENCES ${parent} (id));
       INSERT INTO ${parent} (id) VALUES (1); INSERT INTO ${child} (id, parent_id) VALUES (1, 1)`
    )
    try {
      // child sorts before parent: the dump must still restore (DROP ... CASCADE / FK checks off, FKs last).
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${child},${parent}&format=sql`)).text()
      expect(dump).toContain('dump complete')
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      const errors = restored.filter((r) => r.kind === 'error')
      expect(errors).toEqual([])
      const rows = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${child}/rows`)).json()
      )
      expect(rows.rows).toEqual([[1, 1]])
      const structure = TableSchemaSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${child}/structure`)).json()
      )
      expect(structure.foreignKeys.map((f) => f.refTable)).toEqual([parent])
    } finally {
      await sql(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
    }
  })

  it('restores a MySQL dump into another database without touching the source', async () => {
    if (dialect !== 'mysql') return
    const t = 'dump_move_mysql'
    const src = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    const dst = async (text: string) =>
      req('/api/databases/tsmyadmin_other/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await src(`DROP TABLE IF EXISTS ${t}`)
    await dst(`DROP TABLE IF EXISTS ${t}`)
    await src(`CREATE TABLE ${t} (id INT PRIMARY KEY, v VARCHAR(10)); INSERT INTO ${t} VALUES (1, 'prod')`)
    try {
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql`)).text()
      // Unqualified statements: the dump names no database, so it restores wherever it is imported.
      expect(dump).not.toContain('`tsmyadmin_test`.')
      const restored = z.array(StatementResultSchema).parse(await (await dst(dump)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
      const moved = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_other/tables/${t}/rows`)).json()
      )
      expect(moved.rows).toEqual([[1, 'prod']])
      const source = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${t}/rows`)).json()
      )
      expect(source.rows).toEqual([[1, 'prod']])
    } finally {
      await src(`DROP TABLE IF EXISTS ${t}`)
      await dst(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('logs out', async () => {
    expect((await req('/api/session', { method: 'DELETE' })).status).toBe(200)
  })
})
