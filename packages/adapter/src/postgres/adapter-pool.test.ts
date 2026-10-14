import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'

/**
 * The PostgreSQL adapter's pools and the clients it hands out, with `pg`'s Pool replaced by a fake: what the pool is
 * opened with, when a pool of another database is let go, how a client is set up (search_path, error guard, reset),
 * the notices a statement raises, and the COPY stream.
 */

type CopyStream = EventEmitter & { end: (d: string) => void; rowCount?: number }
type FakePool = EventEmitter & {
  options: Record<string, unknown>
  totalCount: number
  waitingCount: number
  connect: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}
const state = vi.hoisted(() => ({
  pools: [] as unknown[],
  copied: [] as { sql: string; stream: unknown }[],
  /** What the COPY stream does with the data it is given. */
  onEnd: (_stream: unknown, _data: string): void => undefined,
  nextConnect: (async () => {
    throw new Error('no client scripted')
  }) as () => Promise<unknown>,
}))
const pools = state.pools as FakePool[]
const copied = state.copied as { sql: string; stream: CopyStream }[]

vi.mock('pg', async (original) => {
  const actual = await original<typeof import('pg')>()
  const { EventEmitter: Emitter } = await import('node:events')
  class Pool extends Emitter {
    totalCount = 1
    waitingCount = 0
    connect = vi.fn(() => state.nextConnect())
    end = vi.fn(async () => undefined)
    constructor(public options: Record<string, unknown>) {
      super()
      state.pools.push(this)
    }
  }
  return { ...actual, default: { ...actual.default, Pool } }
})
vi.mock('pg-copy-streams', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    from: (sql: string) => {
      const stream = new Emitter() as unknown as CopyStream
      stream.end = (data: string) => state.onEnd(stream, data)
      state.copied.push({ sql, stream })
      return stream
    },
  }
})

const { PostgresAdapter } = await import('./adapter.ts')
const { pgTypes } = await import('./values.ts')

const config = { dialect: 'postgres' as const, host: 'db.example', port: 5433, user: 'u', password: 'secret' }
type Adapter = InstanceType<typeof PostgresAdapter>
type Client = EventEmitter & {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  getTransactionStatus?: () => string
}
const newClient = (answer: (text: string) => unknown = () => ({ fields: [], rows: [], rowCount: 0 })): Client => {
  const c = new EventEmitter() as Client
  c.query = vi.fn(async (q: { text: string } | unknown) => {
    const text = (q as { text?: string }).text ?? ''
    const out = answer(text)
    if (out instanceof Error) throw out
    return out
  })
  c.release = vi.fn()
  return c
}
const connectTo = (...clients: Client[]) => {
  let i = 0
  state.nextConnect = async () => clients[Math.min(i++, clients.length - 1)]
}
const acquire = (a: Adapter, ns: { database: string; schema?: string } = { database: 'postgres' }) =>
  (a as unknown as { acquire: (ns: unknown) => Promise<Conn> }).acquire(ns)
const run = (a: Adapter, c: Client, text: string, params?: unknown[]) =>
  (a as unknown as { run: (c: unknown, t: string, p?: unknown[]) => Promise<unknown> }).run(c, text, params)
const poolMap = (a: Adapter) => (a as unknown as { pools: Map<string, FakePool> }).pools
const poolFor = (a: Adapter, db: string) => (a as unknown as { poolFor: (d: string) => FakePool }).poolFor(db)

beforeEach(() => {
  pools.length = 0
  copied.length = 0
  state.nextConnect = async () => {
    throw new Error('no client scripted')
  }
})

describe('PostgresAdapter: opening a pool', () => {
  it('connects as the account to the host, port and database, the database it signs in to being postgres by default', () => {
    poolFor(new PostgresAdapter(config), 'postgres')
    expect(pools[0]?.options).toMatchObject({
      host: 'db.example',
      port: 5433,
      user: 'u',
      password: 'secret',
      database: 'postgres',
    })
    poolFor(new PostgresAdapter({ ...config, database: 'shop' }), 'other')
    expect(pools[1]?.options).toMatchObject({ database: 'other' })
  })

  it('marks its connections, keeps at most 4 and gives up on a connect after 10 seconds', () => {
    poolFor(new PostgresAdapter(config), 'postgres')
    expect(pools[0]?.options).toMatchObject({
      application_name: 'tsmyadmin',
      max: 4,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
      types: pgTypes,
    })
  })

  it('opens one pool per database and keeps each', () => {
    const a = new PostgresAdapter(config)
    expect(poolFor(a, 'one')).toBe(poolFor(a, 'one'))
    expect(poolFor(a, 'two')).not.toBe(poolFor(a, 'one'))
    expect(pools).toHaveLength(2)
  })

  it('does not stop the process on a pool error', () => {
    const p = poolFor(new PostgresAdapter(config), 'one')
    expect(() => p.emit('error', new Error('idle client failed'))).not.toThrow()
  })

  describe('letting go of the pool of a database that was browsed', () => {
    const idle = (a: Adapter, db: string, state: { totalCount?: number; waitingCount?: number } = {}) => {
      const p = poolFor(a, db)
      Object.assign(p, { totalCount: 0, waitingCount: 0, ...state })
      p.emit('remove')
      return p
    }

    it('ends it and forgets it once its last client is gone', () => {
      const a = new PostgresAdapter(config)
      const p = idle(a, 'one')
      expect(p.end).toHaveBeenCalledTimes(1)
      expect(poolMap(a).has('one')).toBe(false)
    })

    it('keeps it while a client is still in it or a caller is waiting', () => {
      for (const state of [{ totalCount: 1 }, { waitingCount: 1 }, { totalCount: 2, waitingCount: 3 }]) {
        const a = new PostgresAdapter(config)
        const p = idle(a, 'one', state)
        expect(p.end, JSON.stringify(state)).not.toHaveBeenCalled()
        expect(poolMap(a).get('one')).toBe(p)
      }
    })

    it('never lets go of the pool of the database it signs in to', () => {
      const a = new PostgresAdapter({ ...config, database: 'home' })
      const p = idle(a, 'home')
      expect(p.end).not.toHaveBeenCalled()
      expect(poolMap(a).get('home')).toBe(p)
    })

    it('does not end a pool that has already been replaced by a newer one', () => {
      const a = new PostgresAdapter(config)
      const old = poolFor(a, 'one')
      const fresh = poolFor(a, 'two')
      poolMap(a).set('one', fresh)
      Object.assign(old, { totalCount: 0, waitingCount: 0 })
      old.emit('remove')
      expect(old.end).not.toHaveBeenCalled()
      expect(poolMap(a).get('one')).toBe(fresh)
    })
  })
})

describe('PostgresAdapter.acquire: a pool that gives no client', () => {
  const refuse = () => {
    state.nextConnect = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
  }

  it('reports it as an adapter error, and lets go of the pool of another database that never opened a client', async () => {
    refuse()
    const a = new PostgresAdapter({ ...config, database: 'home' })
    const p = poolFor(a, 'other')
    Object.assign(p, { totalCount: 0, waitingCount: 0 })
    await expect(acquire(a, { database: 'other' })).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    expect(p?.end).toHaveBeenCalledTimes(1)
    expect(poolMap(a).has('other')).toBe(false)
  })

  it('keeps the pool of the database it signs in to, and any pool that has clients or callers', async () => {
    refuse()
    const a = new PostgresAdapter({ ...config, database: 'home' })
    await expect(acquire(a, { database: 'home' })).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    expect(poolMap(a).has('home')).toBe(true)
    for (const state of [{ totalCount: 1 }, { waitingCount: 1 }]) {
      const b = new PostgresAdapter({ ...config, database: 'home' })
      const p = poolFor(b, 'other')
      Object.assign(p, { totalCount: 0, waitingCount: 0, ...state })
      await expect(acquire(b, { database: 'other' })).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
      expect(p.end, JSON.stringify(state)).not.toHaveBeenCalled()
      expect(poolMap(b).get('other')).toBe(p)
    }
  })
})

describe('PostgresAdapter.acquire: setting a client up', () => {
  it('points the client at the schema, public unless one is given, quoting the name', async () => {
    const c = newClient()
    connectTo(c)
    await acquire(new PostgresAdapter(config))
    expect(c.query).toHaveBeenCalledWith({ text: 'SET search_path TO "public"', rowMode: 'array' })
    const d = newClient()
    connectTo(d)
    await acquire(new PostgresAdapter(config), { database: 'postgres', schema: 'we"ird' })
    expect(d.query).toHaveBeenCalledWith({ text: 'SET search_path TO "we""ird"', rowMode: 'array' })
  })

  it('does not point a client at the schema it is already on, and does for another one', async () => {
    const c = newClient()
    connectTo(c)
    const a = new PostgresAdapter(config)
    await acquire(a)
    await acquire(a)
    expect(c.query).toHaveBeenCalledTimes(1)
    await acquire(a, { database: 'postgres', schema: 'other' })
    expect(c.query).toHaveBeenCalledTimes(2)
    await acquire(a)
    expect(c.query).toHaveBeenCalledTimes(3)
  })

  it('gives the client back, and forgets its schema, when pointing it fails', async () => {
    const c = newClient((t) =>
      t.startsWith('SET search_path')
        ? Object.assign(new Error('bad'), { code: '3F000' })
        : { fields: [], rows: [], rowCount: 0 }
    )
    connectTo(c)
    const a = new PostgresAdapter(config)
    await expect(acquire(a)).rejects.toMatchObject({ code: 'NOT_FOUND', nativeCode: '3F000' })
    expect(c.release).toHaveBeenCalledTimes(1)
    expect(c.release).toHaveBeenCalledWith(undefined)
    await expect(acquire(a)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(c.query).toHaveBeenCalledTimes(2)
    expect(c.query).toHaveBeenLastCalledWith({ text: 'SET search_path TO "public"', rowMode: 'array' })
  })

  it('watches a client for errors once, and takes a client whose backend was terminated for broken', async () => {
    const c = newClient()
    connectTo(c)
    const a = new PostgresAdapter(config)
    const first = await acquire(a)
    await acquire(a)
    expect(c.listenerCount('error')).toBe(1)
    first.release()
    expect(c.release).toHaveBeenLastCalledWith(undefined)
    c.emit('error', new Error('terminating connection'))
    first.release()
    expect(c.release).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'connection terminated' }))
  })

  it('marks a client broken on request, so it is dropped on release rather than pooled', async () => {
    const c = newClient()
    connectTo(c)
    const conn = await acquire(new PostgresAdapter(config))
    conn.discard()
    conn.release()
    expect(c.release).toHaveBeenCalledWith(expect.any(Error))
    expect(conn.id).toBe(c)
  })

  it('resets the session with DISCARD ALL and forgets the schema, or drops the client when it cannot', async () => {
    const c = newClient()
    connectTo(c)
    const a = new PostgresAdapter(config)
    const conn = await acquire(a)
    await conn.reset?.()
    expect(c.query).toHaveBeenLastCalledWith({ text: 'DISCARD ALL', rowMode: 'array' })
    const before = c.query.mock.calls.length
    await acquire(a)
    expect(c.query.mock.calls.length).toBe(before + 1)
    conn.release()
    expect(c.release).toHaveBeenLastCalledWith(undefined)
    const bad = newClient((t) =>
      t === 'DISCARD ALL' ? Object.assign(new Error('x'), { code: '25001' }) : { fields: [], rows: [], rowCount: 0 }
    )
    connectTo(bad)
    const dead = await acquire(new PostgresAdapter(config))
    await dead.reset?.()
    dead.release()
    expect(bad.release).toHaveBeenLastCalledWith(expect.any(Error))
  })

  it('forgets the schema on request, so the next call points the client at it again', async () => {
    const c = newClient()
    connectTo(c)
    const a = new PostgresAdapter(config)
    const conn = await acquire(a)
    conn.forget?.()
    const before = c.query.mock.calls.length
    await acquire(a)
    expect(c.query.mock.calls.length).toBe(before + 1)
  })

  it('counts a transaction as open when the driver says it is in one, or in one that failed', async () => {
    for (const [status, open] of [
      ['T', true],
      ['E', true],
      ['I', false],
      [undefined, false],
    ] as const) {
      const c = newClient()
      if (status) c.getTransactionStatus = () => status
      connectTo(c)
      const conn = await acquire(new PostgresAdapter(config))
      expect(await conn.inTransaction?.(), String(status)).toBe(open)
    }
  })

  it("passes a statement through run with its parameters, and the client's COPY stream through copyFrom", async () => {
    const c = newClient()
    connectTo(c)
    const conn = await acquire(new PostgresAdapter(config))
    await conn.query('SELECT $1', [5])
    expect(c.query).toHaveBeenLastCalledWith({ text: 'SELECT $1', values: [5], rowMode: 'array' })
    await conn.query('SELECT 1')
    expect(c.query).toHaveBeenLastCalledWith({ text: 'SELECT 1', rowMode: 'array' })
    expect(typeof conn.copyFrom).toBe('function')
  })
})

describe('PostgresAdapter: COPY', () => {
  /** A client whose `query` hands back the stream it was given, as pg does for a COPY. */
  const copying = async () => {
    const c = newClient()
    c.query = vi.fn((q: unknown) =>
      typeof q === 'object' && q !== null && 'text' in q ? Promise.resolve({ fields: [], rows: [], rowCount: 0 }) : q
    )
    connectTo(c)
    return await acquire(new PostgresAdapter(config))
  }

  it('sends the data to the server and resolves to the number of rows it copied', async () => {
    const conn = await copying()
    const seen: string[] = []
    state.onEnd = (stream, data) => {
      seen.push(data)
      ;(stream as CopyStream).rowCount = 3
      ;(stream as CopyStream).emit('finish')
    }
    expect(await conn.copyFrom?.('COPY t FROM STDIN', 'a\tb\n')).toBe(3)
    expect(seen).toEqual(['a\tb\n'])
    expect(copied.at(-1)?.sql).toBe('COPY t FROM STDIN')
  })

  it('resolves to 0 when the server does not say how many rows it copied', async () => {
    const conn = await copying()
    state.onEnd = (stream) => (stream as CopyStream).emit('finish')
    expect(await conn.copyFrom?.('COPY t FROM STDIN', '')).toBe(0)
  })

  it('reports a failure of the stream as an adapter error', async () => {
    const conn = await copying()
    state.onEnd = (stream) =>
      (stream as CopyStream).emit('error', Object.assign(new Error('bad data'), { code: '22P04' }))
    await expect(conn.copyFrom?.('COPY t FROM STDIN', 'x')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      message: '22P04: bad data',
    })
  })
})

describe('PostgresAdapter.run: statements', () => {
  const adapter = new PostgresAdapter(config)

  it('adds the notices a statement raised to its result, each with its severity, and leaves out the debug and log ones', async () => {
    const c = newClient(() => {
      c.emit('notice', { severity: 'WARNING', message: 'no privileges were granted' })
      c.emit('notice', { message: 'plain' })
      c.emit('notice', { severity: 'DEBUG', message: 'noisy' })
      c.emit('notice', { severity: 'LOG', message: 'logged' })
      c.emit('notice', { severity: 'NOTICE' })
      c.emit('notice', { severity: 'NOTICE', message: '' })
      return { fields: [], rows: [], rowCount: 0 }
    })
    expect(await run(adapter, c, 'GRANT x')).toMatchObject({
      notices: ['WARNING: no privileges were granted', 'NOTICE: plain'],
    })
    expect(c.listenerCount('notice')).toBe(0)
    expect(await run(adapter, newClient(), 'SELECT 1')).not.toHaveProperty('notices')
  })

  it('stops listening for notices when the statement fails, and marks the client broken only when it was lost', async () => {
    const lost = newClient(() => Object.assign(new Error('terminated'), { code: '57P01' }))
    await expect(run(adapter, lost, 'SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    expect(lost.listenerCount('notice')).toBe(0)
    const syntax = newClient(() => Object.assign(new Error('syntax'), { code: '42601' }))
    await expect(run(adapter, syntax, 'SELEC')).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    expect(syntax.listenerCount('notice')).toBe(0)
  })

  it('reads a script of several statements as one result each, without notices', async () => {
    const c = newClient(() => [
      { fields: [{ name: 'a', dataTypeID: 23 }], rows: [[1]], rowCount: 1 },
      { fields: [], rows: [], rowCount: 4 },
    ])
    expect(await run(adapter, c, 'SELECT 1; UPDATE t SET a = 1')).toEqual([
      { columns: [{ name: 'a', dataType: 'int4' }], rows: [[1]], affectedRows: 1, hasRows: true },
      { columns: [], rows: [], affectedRows: 4, hasRows: false },
    ])
  })
})
