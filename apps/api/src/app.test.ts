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
