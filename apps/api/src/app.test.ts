import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import {
  ApiErrorSchema,
  BrowseResultSchema,
  DdlPreviewResponseSchema,
  SessionInfoSchema,
  StatementResultSchema,
  TableInfoSchema,
  TableSchemaSchema,
} from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { MemorySessionStore } from './session/store.ts'

const SECRET = 'test-secret'
const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'root', password: 'pw' }

function fixtureAdapter(overrides: ConstructorParameters<typeof FakeAdapter>[0] = {}) {
  return new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'Alice' },
              { id: 2, name: 'Bob' },
              { id: 3, name: 'Carol' },
            ]
          ),
        },
      },
      other: { tables: {} },
    },
    ...overrides,
  })
}

function harness(adapter: FakeAdapter = fixtureAdapter()) {
  const store = new MemorySessionStore({ sweepIntervalMs: 0 })
  const app = createApp({ adapterFactory: () => adapter, store, secret: SECRET, secure: false })
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
    })
  const login = async () => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify(LOGIN) })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    return res
  }
  return { app, store, adapter, req, login, cookie: () => cookie }
}

const stores: MemorySessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})

describe('session', () => {
  it('logs in, sets an HttpOnly signed cookie and never returns the password', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(201)
    const body = SessionInfoSchema.parse(await res.json())
    expect(body).toEqual({ dialect: 'mysql', host: 'db', port: 3306, user: 'root' })
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/tsmyadmin_session=/)
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(h.adapter.calls[0]?.method).toBe('ping')
    const me = await h.req('/api/session')
    expect(me.status).toBe(200)
    expect(SessionInfoSchema.parse(await me.json()).user).toBe('root')
  })

  it('rejects bad credentials with AUTH_FAILED and closes the adapter', async () => {
    const adapter = fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') })
    const h = harness(adapter)
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(401)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('AUTH_FAILED')
    expect(h.store.size).toBe(0)
  })

  it('maps unreachable hosts to 502 CONNECTION_FAILED', async () => {
    const h = harness(fixtureAdapter({ failWith: new AdapterError('CONNECTION_FAILED', 'ECONNREFUSED') }))
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(502)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('CONNECTION_FAILED')
  })

  it('validates the login body', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/api/session', { method: 'POST', body: JSON.stringify({ dialect: 'oracle' }) })
    expect(res.status).toBe(400)
    const err = ApiErrorSchema.parse(await res.json())
    expect(err.code).toBe('VALIDATION')
    expect(err.detail).toContain('dialect')
  })

  it('requires a session for data routes and rejects tampered cookies', async () => {
    const h = harness()
    stores.push(h.store)
    expect((await h.req('/api/databases')).status).toBe(401)
    const forged = await h.app.request('/api/databases', { headers: { cookie: 'tsmyadmin_session=abc.def' } })
    expect(forged.status).toBe(401)
  })

  it('logs out, clears the cookie and closes the adapter', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/session', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect(h.adapter.closed).toBe(true)
    expect((await h.req('/api/session')).status).toBe(401)
  })
})

describe('databases & tables', () => {
  it('lists databases, schemas and tables (contract-checked)', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/databases')).json()).toEqual([{ name: 'other' }, { name: 'shop' }])
    expect(await (await h.req('/api/databases/shop/schemas')).json()).toEqual([])
    const tables = z.array(TableInfoSchema).parse(await (await h.req('/api/databases/shop/tables')).json())
    expect(tables.map((t) => t.name)).toEqual(['users'])
    const structure = TableSchemaSchema.parse(await (await h.req('/api/databases/shop/tables/users/structure')).json())
    expect(structure.primaryKey).toEqual(['id'])
  })

  it('passes ?schema through as the namespace', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    await h.req('/api/databases/shop/tables?schema=app')
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listTables', args: [{ database: 'shop', schema: 'app' }] })
  })

  it('returns 404 NOT_FOUND from the adapter', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/nope/structure')
    expect(res.status).toBe(404)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('NOT_FOUND')
  })
})

describe('rows', () => {
  it('browses with sort/filter/paging from the query string', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req(
      '/api/databases/shop/tables/users/rows?limit=2&offset=1&sort=name:desc&filters=' +
        encodeURIComponent('[{"column":"name","op":"like","value":"%o%"}]')
    )
    expect(res.status).toBe(200)
    const body = BrowseResultSchema.parse(await res.json())
    expect(body.rows).toEqual([[2, 'Bob']])
    expect(body.total).toBe(2)
    expect(h.adapter.calls.at(-1)?.args[2]).toEqual({
      offset: 1,
      limit: 2,
      sort: [{ column: 'name', direction: 'desc' }],
      filters: [{ column: 'name', op: 'like', value: '%o%' }],
    })
  })

  it('rejects malformed browse parameters', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/databases/shop/tables/users/rows?limit=99999')).status).toBe(400)
    expect((await h.req('/api/databases/shop/tables/users/rows?sort=name:up')).status).toBe(400)
    expect((await h.req('/api/databases/shop/tables/users/rows?filters=nope')).status).toBe(400)
  })

  it('inserts, updates and deletes rows', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ins = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'POST',
      body: JSON.stringify({ values: { id: 4, name: 'Dave' } }),
    })
    expect(ins.status).toBe(201)
    const upd = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: 4 } }, values: { name: 'David' } }),
    })
    expect(await upd.json()).toEqual({ affectedRows: 1 })
    const del = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      body: JSON.stringify({
        keys: [
          { kind: 'pk', values: { id: 4 } },
          { kind: 'pk', values: { id: 3 } },
        ],
      }),
    })
    expect(await del.json()).toEqual({ affectedRows: 2 })
    const rows = BrowseResultSchema.parse(await (await h.req('/api/databases/shop/tables/users/rows')).json())
    expect(rows.rows.map((r) => r[1])).toEqual(['Alice', 'Bob'])
  })

  it('returns 409 KEY_MISMATCH when a key matches no row', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: 99 } }, values: { name: 'x' } }),
    })
    expect(res.status).toBe(409)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('KEY_MISMATCH')
  })

  it('rejects invalid row keys and binary cells that are not base64 objects', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      body: JSON.stringify({ keys: [{ kind: 'magic', values: {} }] }),
    })
    expect(res.status).toBe(400)
    const bad = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'POST',
      body: JSON.stringify({ values: { id: 5, name: { nested: true } } }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('sql & ddl', () => {
  it('executes scripts with defaults applied', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) })
    expect(res.status).toBe(200)
    const results = z.array(StatementResultSchema).parse(await res.json())
    expect(results[0]?.kind).toBe('rows')
    expect(h.adapter.calls.at(-1)?.args).toEqual([
      { database: 'shop' },
      'SELECT 1',
      { maxRows: 1000, timeoutMs: 30_000, stopOnError: true },
    ])
  })

  it('caps maxRows and rejects empty scripts', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(
      (await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'x', maxRows: 1e9 }) }))
        .status
    ).toBe(400)
    expect((await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: '' }) })).status).toBe(
      400
    )
  })

  it('previews DDL without executing it', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'dropColumn', table: 'users', name: 'name' } }),
    })
    expect(res.status).toBe(200)
    expect(DdlPreviewResponseSchema.parse(await res.json())).toEqual({
      sql: ['ALTER TABLE `shop`.`users` DROP COLUMN `name`'],
    })
    expect(h.adapter.calls.some((c) => c.method === 'executeSql')).toBe(false)
  })

  it('rejects unknown DDL ops', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameEverything', table: 'users' } }),
    })
    expect(res.status).toBe(400)
  })
})

describe('export', () => {
  it('downloads a SQL dump of the whole database with a content-disposition', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/sql')
    expect(res.headers.get('content-disposition')).toContain('filename="shop.sql"')
    const body = await res.text()
    expect(body).toContain('-- Table: users')
    expect(body).toContain('INSERT INTO `shop`.`users`')
  })

  it('exports one table as CSV and rejects multi-table CSV', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const csv = await h.req('/api/databases/shop/export?format=csv&tables=users')
    expect(csv.status).toBe(200)
    expect(await csv.text()).toContain('id,name')
    expect((await h.req('/api/databases/shop/export?format=csv&tables=users,users2')).status).toBe(400)
    expect((await h.req('/api/databases/shop/export?format=xml')).status).toBe(400)
  })
})

describe('import', () => {
  const upload = (
    h: ReturnType<typeof harness>,
    fields: Record<string, string>,
    file: { name: string; body: string }
  ) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([file.body], file.name, { type: 'text/plain' }))
    // Browsers send Origin on same-origin form posts; hono/csrf requires it for multipart bodies.
    return h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
  }

  it('imports a SQL file and reports per-statement results', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await upload(h, { format: 'sql' }, { name: 'dump.sql', body: 'INSERT INTO users VALUES (9); SELECT 1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ format: 'sql', statements: 1, succeeded: 1, failed: 0 })
  })

  it('imports a CSV into a table and rejects bad headers with 400', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await upload(h, { format: 'csv', table: 'users' }, { name: 'u.csv', body: 'id,name\n7,Zed\n' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ format: 'csv', inserted: 1, columns: ['id', 'name'] })
    const rows = BrowseResultSchema.parse(await (await h.req('/api/databases/shop/tables/users/rows')).json())
    expect(rows.rows.some((r) => r[1] === 'Zed')).toBe(true)
    const bad = await upload(h, { format: 'csv', table: 'users' }, { name: 'u.csv', body: 'nope\n1\n' })
    expect(bad.status).toBe(400)
    expect(ApiErrorSchema.parse(await bad.json()).code).toBe('VALIDATION')
  })

  it('rejects cross-site form posts (CSRF) with 403', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const fd = new FormData()
    fd.set('format', 'sql')
    fd.set('file', new File(['SELECT 1'], 'x.sql'))
    const res = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('requires a file and a valid format', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const fd = new FormData()
    fd.set('format', 'sql')
    const noFile = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
    expect(noFile.status).toBe(400)
    expect((await upload(h, { format: 'xml' }, { name: 'x', body: 'x' })).status).toBe(400)
  })
})

describe('users', () => {
  const withUsers = () =>
    fixtureAdapter({
      // Real drivers return affected-row results for account statements (never the SQL text).
      onSql: (_ns, sql) => [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }],
      users: [
        { name: 'root', host: 'localhost', canLogin: true, attributes: [] },
        { name: 'app', host: '%', canLogin: false, attributes: ['LOCKED'] },
      ],
    })

  it('lists users and shows grants', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const users = await (await h.req('/api/users')).json()
    expect(users).toHaveLength(2)
    const grants = await (await h.req('/api/users/grants?name=app&host=%25')).json()
    expect(grants).toEqual({ statements: ["GRANT USAGE ON *.* TO 'app'@'%'"] })
    expect((await h.req('/api/users/grants?name=ghost')).status).toBe(404)
  })

  it('previews masked SQL and executes the real statements without echoing the password', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const op = {
      op: 'createUser',
      user: { name: 'new', host: '%' },
      password: 'hunter2',
      attributes: { createdb: true },
    }
    const preview = (await (
      await h.req('/api/users/preview', { method: 'POST', body: JSON.stringify({ op }) })
    ).json()) as { sql: string[] }
    expect(preview.sql[0]).toBe("CREATE USER 'new'@'%' IDENTIFIED BY '****'")
    expect(JSON.stringify(preview)).not.toContain('hunter2')
    const res = await h.req('/api/users/execute', { method: 'POST', body: JSON.stringify({ op }) })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('hunter2')
    const executed = h.adapter.calls.filter((c) => c.method === 'executeSql')
    expect(executed.map((c) => c.args[1])).toEqual([
      "CREATE USER 'new'@'%' IDENTIFIED BY 'hunter2'",
      "GRANT CREATE ON *.* TO 'new'@'%'",
    ])
    expect(executed[0]?.args[0]).toEqual({ database: 'information_schema' })
  })

  it('validates user ops', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    expect(
      (await h.req('/api/users/preview', { method: 'POST', body: JSON.stringify({ op: { op: 'nuke' } }) })).status
    ).toBe(400)
    expect((await h.req('/api/users')).status).toBe(200)
    expect((await h.app.request('/api/users')).status).toBe(401)
  })
})

describe('errors', () => {
  it('normalises unexpected errors as 500 INTERNAL without leaking stack traces', async () => {
    const adapter = fixtureAdapter()
    adapter.listDatabases = async () => {
      throw new Error('boom')
    }
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases')
    expect(res.status).toBe(500)
    const err = ApiErrorSchema.parse(await res.json())
    expect(err.code).toBe('INTERNAL')
    expect(err.message).toBe('Internal error')
  })
})
