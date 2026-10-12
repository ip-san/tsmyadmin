import type { TableSchema } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'
import { rows, scripted } from '../test/scripted-conn.ts'

/**
 * The PostgreSQL full scan (a server-side cursor, which the exports read), the small session statements, the
 * connection that cancels statements, and ping / close, with the connection or `pg` replaced by a fake.
 */

const state = vi.hoisted(() => ({
  clients: [] as { options: Record<string, unknown>; query: unknown; connect: unknown; end: unknown }[],
  connect: (async () => undefined) as () => Promise<void>,
  query: (async () => ({ rows: [] })) as (text: string, values?: unknown[]) => Promise<unknown>,
}))

vi.mock('pg', async (original) => {
  const actual = await original<typeof import('pg')>()
  const { EventEmitter: Emitter } = await import('node:events')
  class Client extends Emitter {
    connect = vi.fn(() => state.connect())
    end = vi.fn(async () => undefined)
    query = vi.fn((text: string, values?: unknown[]) => state.query(text, values))
    constructor(public options: Record<string, unknown>) {
      super()
      state.clients.push(this as never)
    }
  }
  return { ...actual, default: { ...actual.default, Client } }
})

const { PostgresAdapter } = await import('./adapter.ts')
type Adapter = InstanceType<typeof PostgresAdapter>

const config = {
  dialect: 'postgres' as const,
  host: 'db.example',
  port: 5433,
  user: 'u',
  password: 'secret',
  database: 'home',
}
const ns = { database: 'd', schema: 'sales' }
type Internals = Record<string, ((...args: unknown[]) => unknown) | undefined>
const internals = (a: Adapter) => a as unknown as Internals

beforeEach(() => {
  state.clients.length = 0
  state.connect = async () => undefined
  state.query = async () => ({ rows: [] })
})

const column = (name: string, nullable = false) => ({ name, dataType: 'int', nullable })
const schemaOf = (parts: Record<string, unknown>) =>
  ({
    kind: 'table',
    primaryKey: [],
    indexes: [],
    partitioned: false,
    hasChildren: false,
    ...parts,
  }) as unknown as TableSchema

describe('PostgresAdapter.iterateRows: a server-side cursor', () => {
  /** A connection whose FETCH answers with the next page. */
  const scan = (pages: unknown[][][], failOn?: RegExp) => {
    const adapter = new PostgresAdapter(config)
    let page = 0
    const asked: string[] = []
    const done = vi.fn(async () => undefined)
    const conn = {
      query: async (text: string) => {
        asked.push(text)
        if (failOn?.test(text)) throw new Error('boom')
        if (text.startsWith('FETCH')) return rows(pages[page++] ?? [], ['id', 'name'])
        return rows([])
      },
    } as unknown as Conn
    internals(adapter).borrow = async () => ({ conn, done })
    return { adapter, asked, done }
  }
  const collect = async (it: AsyncIterable<{ rows: unknown[][] }>) => {
    const out: unknown[][][] = []
    for await (const b of it) out.push(b.rows)
    return out
  }
  const keyed = schemaOf({ columns: [column('id'), column('name', true)], primaryKey: ['id'] })

  it('reads the pages through a cursor inside one transaction, closes it and commits', async () => {
    const { adapter, asked, done } = scan([
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [[3, 'c']],
    ])
    expect(await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))).toEqual([
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [[3, 'c']],
    ])
    expect(asked).toEqual([
      'BEGIN',
      'DECLARE tsmyadmin_export NO SCROLL CURSOR FOR SELECT "id", "name" FROM ONLY "sales"."t" ORDER BY "id"',
      'FETCH 2 FROM tsmyadmin_export',
      'FETCH 2 FROM tsmyadmin_export',
      'CLOSE tsmyadmin_export',
      'COMMIT',
    ])
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('stops after a full page followed by an empty one, without yielding the empty one', async () => {
    const { adapter, asked } = scan([
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [],
    ])
    expect(await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))).toEqual([
      [
        [1, 'a'],
        [2, 'b'],
      ],
    ])
    expect(asked.filter((q) => q.startsWith('FETCH'))).toHaveLength(2)
  })

  it('still yields one empty batch for an empty table, so the caller learns the columns', async () => {
    const { adapter } = scan([[]])
    expect(await collect(adapter.iterateRows(ns, 't', { batchSize: 5, schema: keyed }))).toEqual([[]])
  })

  it('reads times as UTC for this transaction only when asked', async () => {
    const utc = scan([[]])
    await collect(utc.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed, utc: true }))
    expect(utc.asked[1]).toBe("SET LOCAL TIME ZONE 'UTC'")
    const plain = scan([[]])
    await collect(plain.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))
    expect(plain.asked.some((q) => q.includes('TIME ZONE'))).toBe(false)
  })

  it('leaves out ONLY for a partitioned parent, and does not order a table without a key', async () => {
    const { adapter, asked } = scan([[]])
    await collect(
      adapter.iterateRows(ns, 't', { batchSize: 2, schema: schemaOf({ columns: [column('id')], partitioned: true }) })
    )
    expect(asked[1]).toBe('DECLARE tsmyadmin_export NO SCROLL CURSOR FOR SELECT "id" FROM "sales"."t"')
  })

  it('orders by every column of a composite key, in key order', async () => {
    const { adapter, asked } = scan([[]])
    await collect(
      adapter.iterateRows(ns, 't', {
        batchSize: 2,
        schema: schemaOf({ columns: [column('a'), column('b')], primaryKey: ['b', 'a'] }),
      })
    )
    expect(asked[1]).toContain('ORDER BY "b", "a"')
  })

  it('rounds a batch size below 1 or with a fraction down to a whole number, at least 1', async () => {
    for (const [given, used] of [
      [0, 1],
      [-4, 1],
      [2.9, 2],
    ] as const) {
      const { adapter, asked } = scan([[]])
      await collect(adapter.iterateRows(ns, 't', { batchSize: given, schema: keyed }))
      expect(
        asked.find((q) => q.startsWith('FETCH')),
        String(given)
      ).toBe(`FETCH ${used} FROM tsmyadmin_export`)
    }
  })

  it('describes the table itself when it is not given the schema', async () => {
    const { adapter } = scan([[]])
    const describeTable = vi.fn(async () => keyed)
    internals(adapter).describeTable = describeTable
    await collect(adapter.iterateRows(ns, 'orders', { batchSize: 2 }))
    expect(describeTable).toHaveBeenCalledWith(ns, 'orders')
  })

  it('rolls the transaction back, and gives the connection back, when the consumer leaves early or a statement fails', async () => {
    const early = scan([
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [[3, 'c']],
    ])
    for await (const _ of early.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed })) {
      void _
      break
    }
    expect(early.asked.at(-1)).toBe('ROLLBACK')
    expect(early.asked).not.toContain('COMMIT')
    expect(early.done).toHaveBeenCalledTimes(1)
    const failing = scan([], /^DECLARE/)
    await expect(collect(failing.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))).rejects.toThrow('boom')
    expect(failing.asked.at(-1)).toBe('ROLLBACK')
    expect(failing.done).toHaveBeenCalledTimes(1)
  })

  it('does not hide the first failure when the rollback fails as well', async () => {
    const both = scan([], /^(DECLARE|ROLLBACK)/)
    await expect(collect(both.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))).rejects.toThrow('boom')
    expect(both.done).toHaveBeenCalledTimes(1)
  })

  it('does not roll back a scan that committed', async () => {
    const ok = scan([[]])
    await collect(ok.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))
    expect(ok.asked).not.toContain('ROLLBACK')
  })
})

describe('PostgresAdapter: the small session statements', () => {
  const s = (answer: unknown[][] = []) => scripted([[/./, rows(answer)]])

  it('limits statement time in milliseconds, whole and not below 0', async () => {
    const a = new PostgresAdapter(config)
    const set = async (ms: number) => {
      const c = s()
      await internals(a).setStatementTimeout?.(c.conn, ms)
      return c.asked[0]?.text
    }
    expect(await set(1500.7)).toBe('SET statement_timeout = 1500')
    expect(await set(-5)).toBe('SET statement_timeout = 0')
  })

  it('names the backend by its process id, empty when the server says nothing', async () => {
    const a = new PostgresAdapter(config)
    const c = s([[4242]])
    expect(await internals(a).backendId?.(c.conn)).toBe('4242')
    expect(c.asked[0]?.text).toBe('SELECT pg_backend_pid()')
    expect(await internals(a).backendId?.(s([]).conn)).toBe('')
    expect(await internals(a).backendId?.(s([[null]]).conn)).toBe('')
  })

  it('has the answers of its dialect', () => {
    const a = new PostgresAdapter(config)
    expect(internals(a).nullSafeEq?.()).toBe('IS NOT DISTINCT FROM')
    expect(internals(a).fallbackKeyKind?.()).toBe('ctid')
    expect(internals(a).fallbackKeySelect?.()).toBe('ctid::text AS "ctid"')
  })
})

describe('PostgresAdapter: the connection that cancels statements', () => {
  it('connects on its own to the database it signs in to, as the same account', async () => {
    await internals(new PostgresAdapter(config)).openCanceller?.(ns)
    expect(state.clients[0]?.options).toMatchObject({
      host: 'db.example',
      port: 5433,
      user: 'u',
      password: 'secret',
      database: 'home',
      connectionTimeoutMillis: 10_000,
    })
  })

  it('cancels a statement by the process id as a number, and closes without failing', async () => {
    const seen: { text: string; values?: unknown[] }[] = []
    state.query = async (text, values) => {
      seen.push({ text, ...(values ? { values } : {}) })
      return { rows: [] }
    }
    const c = (await internals(new PostgresAdapter(config)).openCanceller?.(ns)) as {
      cancel: (id: string) => Promise<void>
      close: () => Promise<void>
    }
    await c.cancel('4242')
    expect(seen).toEqual([{ text: 'SELECT pg_cancel_backend($1::int)', values: [4242] }])
    await c.close()
    expect(state.clients[0]?.end).toHaveBeenCalledTimes(1)
    ;(state.clients[0] as unknown as { end: ReturnType<typeof vi.fn> }).end.mockRejectedValueOnce(
      new Error('already closed')
    )
    await expect(c.close()).resolves.toBeUndefined()
  })

  it('reports a failed cancel as an adapter error', async () => {
    state.query = async () => {
      throw Object.assign(new Error('terminating connection'), { code: '57P01' })
    }
    const c = (await internals(new PostgresAdapter(config)).openCanceller?.(ns)) as {
      cancel: (id: string) => Promise<void>
    }
    await expect(c.cancel('1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
  })

  it('closes the connection and reports the failure when it cannot connect', async () => {
    state.connect = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    await expect(internals(new PostgresAdapter(config)).openCanceller?.(ns)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    })
    expect(state.clients[0]?.end).toHaveBeenCalledTimes(1)
  })
})

describe('PostgresAdapter: ping and close', () => {
  const poolOf = (a: Adapter, answer: () => Promise<unknown>) => {
    const query = vi.fn(answer)
    const end = vi.fn(async () => undefined)
    ;(a as unknown as { pools: Map<string, unknown> }).pools.set('home', { query, end })
    return { query, end }
  }

  it('pings the database it signs in to with SELECT 1, and reports a failure as an adapter error', async () => {
    const a = new PostgresAdapter(config)
    const ok = poolOf(a, async () => ({ rows: [] }))
    await expect(a.ping()).resolves.toBeUndefined()
    expect(ok.query).toHaveBeenCalledWith('SELECT 1')
    const b = new PostgresAdapter(config)
    poolOf(b, async () => {
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' })
    })
    await expect(b.ping()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
  })

  it('ends every pool it opened and forgets them', async () => {
    const a = new PostgresAdapter(config)
    const one = poolOf(a, async () => ({ rows: [] }))
    const map = (a as unknown as { pools: Map<string, unknown> }).pools
    const end2 = vi.fn(async () => undefined)
    map.set('other', { query: vi.fn(), end: end2 })
    await a.close()
    expect(one.end).toHaveBeenCalledTimes(1)
    expect(end2).toHaveBeenCalledTimes(1)
    expect(map.size).toBe(0)
    await expect(a.close()).resolves.toBeUndefined()
  })
})
