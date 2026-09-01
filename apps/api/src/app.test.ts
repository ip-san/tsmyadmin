import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import {
  ApiErrorSchema,
  BrowseResultSchema,
  DdlPreviewResponseSchema,
  KeyValueSchema,
  ProcessInfoSchema,
  ServerInfoSchema,
  SessionInfoSchema,
  StatementResultSchema,
  TableInfoSchema,
  TableSchemaSchema,
} from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { createLogger } from './lib/logging.ts'
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

interface HarnessOptions {
  allowedHosts?: string[]
  loginRateLimit?: { max: number; windowMs: number }
  now?: () => number
  trustProxy?: boolean
}

function harness(adapter: FakeAdapter = fixtureAdapter(), options: HarnessOptions = {}) {
  const store = new MemorySessionStore({ sweepIntervalMs: 0 })
  const app = createApp({
    adapterFactory: () => adapter,
    store,
    secret: SECRET,
    secure: false,
    allowedHosts: options.allowedHosts ?? ['db', '127.0.0.1'],
    ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
  })
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
    })
  const login = async (body: Record<string, unknown> = LOGIN, headers: Record<string, string> = {}) => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body), headers })
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

describe('hardening', () => {
  it('refuses hosts outside the allowlist with 403 FORBIDDEN before touching the adapter', async () => {
    const h = harness(fixtureAdapter(), { allowedHosts: ['db.internal', '*.rds.amazonaws.com'] })
    stores.push(h.store)
    const res = await h.login({ ...LOGIN, host: 'evil.example' })
    expect(res.status).toBe(403)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('FORBIDDEN')
    expect(h.adapter.calls).toHaveLength(0)
    expect((await h.login({ ...LOGIN, host: 'prod.rds.amazonaws.com' })).status).toBe(201)
  })

  it('rate-limits login attempts per IP + user and recovers after the window', async () => {
    let t = 0
    const h = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      loginRateLimit: { max: 2, windowMs: 1000 },
      now: () => t,
    })
    stores.push(h.store)
    expect((await h.login()).status).toBe(401)
    expect((await h.login()).status).toBe(401)
    const blocked = await h.login()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('1')
    expect(ApiErrorSchema.parse(await blocked.json()).code).toBe('RATE_LIMITED')
    expect((await h.login({ ...LOGIN, user: 'other' })).status).toBe(401)
    t = 1000
    expect((await h.login()).status).toBe(401)
  })

  it('keys the limiter by X-Forwarded-For only when the proxy is trusted', async () => {
    const trusted = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      loginRateLimit: { max: 1, windowMs: 60_000 },
      trustProxy: true,
    })
    stores.push(trusted.store)
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(401)
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(401)
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429)
  })

  it('sets security headers, a request id and answers health probes', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/healthz')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/)
    expect((await h.req('/readyz')).status).toBe(200)
    const broken = new MemorySessionStore({ sweepIntervalMs: 0 })
    broken.ping = async () => {
      throw new Error('store down')
    }
    const app = createApp({ adapterFactory: () => fixtureAdapter(), store: broken, secret: SECRET, secure: false })
    expect((await app.request('/readyz')).status).toBe(503)
  })
})

describe('audit log', () => {
  it('records mutating calls with the session identity and never the password being set', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) => [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }],
      users: [],
    })
    const store = new MemorySessionStore({ sweepIntervalMs: 0 })
    stores.push(store)
    const app = createApp({
      adapterFactory: () => adapter,
      store,
      secret: SECRET,
      secure: false,
      allowedHosts: ['db'],
      logger,
    })
    const login = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LOGIN),
    })
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    await app.request('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ keys: [{ kind: 'pk', values: { id: 1 } }] }),
    })
    await app.request('/api/users/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ op: { op: 'setPassword', user: { name: 'x', host: '%' }, password: 'hunter2' } }),
    })
    const audits = lines.filter((l) => l.event === 'audit')
    expect(audits.map((a) => a.action)).toEqual(['deleteRows', 'executeSql'])
    expect(audits[0]).toMatchObject({ dbUser: 'root', dbHost: 'db:3306', table: 'users', rows: 1, ok: true })
    for (const a of audits) expect(String(a.requestId)).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.stringify(lines)).not.toContain('hunter2')
    expect(audits[1]?.sql).toContain('****')
  })
})

describe('server presets', () => {
  it('exposes configured presets without authentication and never credentials', async () => {
    const store = new MemorySessionStore({ sweepIntervalMs: 0 })
    stores.push(store)
    const app = createApp({
      adapterFactory: () => fixtureAdapter(),
      store,
      secret: SECRET,
      secure: false,
      servers: [{ name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432, database: 'app' }],
    })
    const res = await app.request('/api/servers')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432, database: 'app' },
    ])
    const none = createApp({ adapterFactory: () => fixtureAdapter(), store, secret: SECRET, secure: false })
    expect(await (await none.request('/api/servers')).json()).toEqual([])
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

  it('passes queryId through and cancels by id', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const queryId = crypto.randomUUID()
    await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', queryId }) })
    expect(h.adapter.calls.at(-1)?.args[2]).toMatchObject({ queryId })
    const miss = await h.req('/api/databases/shop/sql/cancel', { method: 'POST', body: JSON.stringify({ queryId }) })
    expect(await miss.json()).toEqual({ cancelled: false })
    expect(
      (await h.req('/api/databases/shop/sql/cancel', { method: 'POST', body: JSON.stringify({ queryId: 'nope' }) }))
        .status
    ).toBe(400)
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

  it('aborts the transfer when the adapter fails mid-stream', async () => {
    const adapter = fixtureAdapter()
    const original = adapter.iterateRows.bind(adapter)
    adapter.iterateRows = async function* (ns, table, opts) {
      for await (const b of original(ns, table, opts)) {
        yield b
        throw new Error('connection lost')
      }
    }
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/export')
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
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
    expect(executed).toHaveLength(1)
    expect(executed[0]?.args[1]).toBe(
      "CREATE USER 'new'@'%' IDENTIFIED BY 'hunter2';\nGRANT CREATE ON *.* TO 'new'@'%'"
    )
    expect(executed[0]?.args[0]).toEqual({ database: 'information_schema' })
  })

  it('scrubs the password from error messages that quote the failing SQL', async () => {
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) => [
        {
          kind: 'error',
          sql,
          message: `You have an error in your SQL syntax near 'IDENTIFIED BY 'hunter2'' at line 1`,
          code: 'QUERY_FAILED',
        },
      ],
      users: [],
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/users/execute', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'setPassword', user: { name: 'x', host: '%' }, password: 'hunter2' } }),
    })
    const body = await res.text()
    expect(body).not.toContain('hunter2')
    expect(body).toContain('****')
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

describe('server', () => {
  const withProcesses = () =>
    fixtureAdapter({
      processes: [
        { id: '7', user: 'root', host: 'localhost', database: 'shop', state: 'Query', timeSec: 3, query: 'SELECT 1' },
        { id: '8', user: 'app', host: '10.0.0.1', database: null, state: 'Sleep', timeSec: 120, query: null },
      ],
    })

  it('exposes info, variables, status and processes', async () => {
    const h = harness(withProcesses())
    stores.push(h.store)
    await h.login()
    expect(ServerInfoSchema.parse(await (await h.req('/api/server/info')).json()).version).toBe('0.0.0-fake')
    expect(
      z
        .array(KeyValueSchema)
        .parse(await (await h.req('/api/server/variables')).json())
        .some((v) => v.name === 'max_connections')
    ).toBe(true)
    expect(z.array(KeyValueSchema).parse(await (await h.req('/api/server/status')).json())).toHaveLength(1)
    expect(z.array(ProcessInfoSchema).parse(await (await h.req('/api/server/processes')).json())).toHaveLength(2)
  })

  it('kills a process by numeric id only', async () => {
    const h = harness(withProcesses())
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/server/processes/8/kill', { method: 'POST' })).status).toBe(200)
    expect(
      z
        .array(ProcessInfoSchema)
        .parse(await (await h.req('/api/server/processes')).json())
        .map((p) => p.id)
    ).toEqual(['7'])
    expect((await h.req('/api/server/processes/8/kill', { method: 'POST' })).status).toBe(404)
    expect((await h.req('/api/server/processes/abc/kill', { method: 'POST' })).status).toBe(400)
    expect(
      (await h.app.request('/api/server/processes/7/kill', { method: 'POST', headers: { origin: 'http://localhost' } }))
        .status
    ).toBe(401)
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
