import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { ApiErrorSchema, type Dialect, SnapshotListSchema } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SNAPSHOT_TTL_MS } from '../lib/snapshots.ts'
import { capture, closeStoresAfterEach, eventsOf, harness } from '../test/app-harness.ts'

/**
 * The snapshot routes' edges: who may call them, what an unknown ID answers, what is logged and what a failure
 * becomes (found as surviving mutants; see `bun run mutation`).
 */

/** A server of one kind, holding one table, that runs whatever script it is handed. */
const server = (dialect: Dialect = 'mysql') =>
  new FakeAdapter({
    dialect,
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

const stores = closeStoresAfterEach()
afterEach(() => vi.useRealTimers())
const setup = async (signedIn = true, adapterFactory?: () => FakeAdapter) => {
  const { lines, logger } = capture()
  // A fixed clock for sessions: a test that moves the system date must not log the session out.
  const h = harness(server(), { logger, storeNow: () => 0, ...(adapterFactory ? { adapterFactory } : {}) })
  stores.push(h.store)
  if (signedIn) await h.login()
  return { ...h, events: (event: string) => eventsOf(lines, event) }
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
    // The same account signs in to a server of the other kind after the snapshot was taken (the snapshots are held
    // per account, not per session): the dump says in its header which kind it came from.
    let adapter = server()
    const h = await setup(true, () => adapter)
    const id = SnapshotListSchema.parse(await (await take(h, 'a')).json()).snapshots[0]?.id ?? ''
    adapter = server('postgres')
    await h.login()
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
    // Not a store outage either (that would be 503): an error of no known kind is the plain 500.
    expect(res.status).toBe(500)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('INTERNAL')
  })
})
