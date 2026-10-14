import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ApiErrorSchema, SnapshotListSchema } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { createLogger } from '../lib/logging.ts'
import { SNAPSHOT_TTL_MS } from '../lib/snapshots.ts'
import { MemorySessionStore } from '../session/store.ts'

/**
 * The snapshot routes' edges: who may call them, what an unknown ID answers, what is logged and what a failure
 * becomes (found as surviving mutants; see `bun run mutation`).
 */

const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'root', password: 'pw' }

function harness() {
  const adapter = new FakeAdapter({
    databases: { shop: { tables: { users: fakeTable('users', ['id'], [{ id: 1 }]) } } },
    onSql: (_ns, _sql, opts) =>
      (opts.statements ?? []).map((s, i) => ({
        kind: 'affected' as const,
        sql: s.sql,
        affectedRows: 0,
        durationMs: 1,
        statement: i,
      })),
  })
  // A fixed clock for sessions: a test that moves the system date must not log the session out.
  const store = new MemorySessionStore({ adapterFactory: () => adapter, sweepIntervalMs: 0, now: () => 0 })
  const lines: Record<string, unknown>[] = []
  const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
  const app = createApp({ ...loadConfig({}), sessionSecret: 'x'.repeat(48), allowedHosts: ['db'] }, { store, logger })
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    })
  const login = async () => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify(LOGIN) })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  }
  const events = (event: string) => lines.filter((l) => l.event === event)
  return { adapter, store, req, login, lines, events }
}

const stores: MemorySessionStore[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const s of stores.splice(0)) await s.closeAll()
})
const setup = async (signedIn = true) => {
  const h = harness()
  stores.push(h.store)
  if (signedIn) await h.login()
  return h
}
const take = (h: Awaited<ReturnType<typeof setup>>, name: string, query = '') =>
  h.req(`/api/databases/shop/snapshots${query}`, { method: 'POST', body: JSON.stringify({ name }) })

describe('who may call them', () => {
  it('nobody without a session: every route answers 401', async () => {
    const h = await setup(false)
    const calls: [string, string][] = [
      ['GET', '/api/databases/shop/snapshots'],
      ['POST', '/api/databases/shop/snapshots'],
      ['DELETE', '/api/databases/shop/snapshots/1'],
      ['GET', '/api/databases/shop/snapshots/1/restore/preview'],
      ['POST', '/api/databases/shop/snapshots/1/restore'],
    ]
    for (const [method, path] of calls) {
      const res = await h.req(path, { method, ...(method === 'POST' ? { body: JSON.stringify({ name: 'x' }) } : {}) })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('an ID that is not there', () => {
  it('is "not found" with the same words for a delete, a preview and a restore', async () => {
    const h = await setup()
    const calls: [string, string][] = [
      ['DELETE', '/api/databases/shop/snapshots/99'],
      ['GET', '/api/databases/shop/snapshots/99/restore/preview'],
      ['POST', '/api/databases/shop/snapshots/99/restore'],
    ]
    for (const [method, path] of calls) {
      const res = await h.req(path, { method })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(ApiErrorSchema.parse(await res.json()), `${method} ${path}`).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Unknown snapshot',
      })
    }
  })
})

describe('what is logged', () => {
  it('says a snapshot was taken, of which database, and nothing else about it', async () => {
    const h = await setup()
    await take(h, 'secret-name')
    expect(h.events('snapshot.taken')).toEqual([
      { time: expect.any(String), level: 'info', event: 'snapshot.taken', database: 'shop' },
    ])
  })

  it('keeps the schemas of one database apart, and names the schema in the line', async () => {
    const h = await setup()
    expect((await take(h, 'in app', '?schema=app')).status).toBe(200)
    expect(h.events('snapshot.taken')).toMatchObject([{ database: 'shop', schema: 'app' }])
    const none = SnapshotListSchema.parse(await (await h.req('/api/databases/shop/snapshots')).json())
    expect(none.snapshots).toEqual([])
    const app = SnapshotListSchema.parse(await (await h.req('/api/databases/shop/snapshots?schema=app')).json())
    expect(app.snapshots.map((s) => s.name)).toEqual(['in app'])
    const other = SnapshotListSchema.parse(await (await h.req('/api/databases/shop/snapshots?schema=other')).json())
    expect(other.snapshots).toEqual([])
  })

  it('says what a restore ran: the database, the schema, how many statements and how many failed', async () => {
    const h = await setup()
    const id = SnapshotListSchema.parse(await (await take(h, 'a', '?schema=app')).json()).snapshots[0]?.id ?? ''
    const res = await h.req(`/api/databases/shop/snapshots/${id}/restore?schema=app`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { statements: number; failed: number }
    await Promise.resolve()
    expect(h.events('snapshot.restored')).toEqual([
      {
        time: expect.any(String),
        level: 'info',
        event: 'snapshot.restored',
        database: 'shop',
        schema: 'app',
        statements: body.statements,
        failed: body.failed,
      },
    ])
    // Without a schema, the line has none.
    const id2 = SnapshotListSchema.parse(await (await take(h, 'b')).json()).snapshots[0]?.id ?? ''
    await (await h.req(`/api/databases/shop/snapshots/${id2}/restore`, { method: 'POST' })).text()
    expect(h.events('snapshot.restored')[1]).not.toHaveProperty('schema')
  })

  it('says how many were let go when they expire, a day after they were taken', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'))
    const h = await setup()
    await take(h, 'a')
    await take(h, 'b')
    vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 1000)
    const list = SnapshotListSchema.parse(await (await h.req('/api/databases/shop/snapshots')).json())
    expect(list.snapshots).toEqual([])
    expect(h.events('snapshot.expired')).toEqual([
      { time: expect.any(String), level: 'info', event: 'snapshot.expired', count: 2 },
    ])
  })
})

describe('what a failure becomes', () => {
  it('an error that is not the store refusing is not dressed up as a validation error', async () => {
    const h = await setup()
    h.adapter.listTables = async () => {
      throw new Error('catalog exploded')
    }
    const res = await take(h, 'a')
    expect(res.status).toBe(500)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('INTERNAL')
  })

  it('a restore the import runner refuses before running is 400 with the reason it gives', async () => {
    const h = await setup()
    const id = SnapshotListSchema.parse(await (await take(h, 'a')).json()).snapshots[0]?.id ?? ''
    // The server is no longer the kind the dump was taken from: the dump says so in its header.
    ;(h.adapter as { dialect: string }).dialect = 'postgres'
    const res = await h.req(`/api/databases/shop/snapshots/${id}/restore`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'VALIDATION', reason: 'WRONG_DIALECT' })
  })

  it('an unexpected error in a restore is not a validation error either', async () => {
    const h = await setup()
    const id = SnapshotListSchema.parse(await (await take(h, 'a')).json()).snapshots[0]?.id ?? ''
    h.adapter.executeSql = async () => {
      throw new Error('connection lost')
    }
    const res = await h.req(`/api/databases/shop/snapshots/${id}/restore`, { method: 'POST' })
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
