import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import { MysqlAdapter } from './adapter.ts'

/**
 * The full scan of a table (`iterateRows`, which the exports read) and the row stream under it, plus the small
 * session statements of the adapter, each with its connection scripted or faked.
 */

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'p' }
const ns = { database: 'shop' }
type Internals = Record<string, (...args: unknown[]) => unknown>
const internals = (a: MysqlAdapter) => a as unknown as Internals

const column = (name: string, dataType = 'int', nullable = false) => ({ name, dataType, nullable })
const schemaOf = (parts: { columns: ReturnType<typeof column>[]; primaryKey?: string[]; indexes?: unknown[] }) =>
  ({ kind: 'table', primaryKey: [], indexes: [], ...parts }) as unknown as TableSchema

describe('MysqlAdapter.iterateRows: keyset paging', () => {
  /** A connection that answers each SELECT with the next page; `streamed` makes it offer a row stream. */
  const scan = (pages: unknown[][][], opts: { stream?: boolean } = {}) => {
    const adapter = new MysqlAdapter(config)
    let page = 0
    const s = scripted([])
    const asked: { text: string; params: unknown[] | undefined }[] = []
    const reset = vi.fn(async () => undefined)
    const done = vi.fn(async () => undefined)
    const streamed: { text: string; params: unknown[]; batch: number }[] = []
    const conn = {
      ...s.conn,
      reset,
      query: async (text: string, params?: unknown[]) => {
        asked.push({ text, params })
        if (text.startsWith('SET SESSION time_zone')) return rows([])
        return rows(pages[page++] ?? [], ['id', 'name'])
      },
      ...(opts.stream
        ? {
            stream: async function* (text: string, params: unknown[], batch: number) {
              streamed.push({ text, params, batch })
              yield rows([[1, 'a']], ['id', 'name'])
              yield rows([[2, 'b']], ['id', 'name'])
            },
          }
        : {}),
    } as unknown as Conn
    internals(adapter).borrow = async () => ({ conn, done })
    return { adapter, asked, reset, done, streamed }
  }
  const collect = async (it: AsyncIterable<{ columns: unknown; rows: unknown[][] }>) => {
    const out: unknown[][][] = []
    for await (const b of it) out.push(b.rows)
    return out
  }
  const keyed = schemaOf({ columns: [column('id'), column('name', 'varchar(10)', true)], primaryKey: ['id'] })

  it('reads the pages in key order, each after the last key of the one before, and stops at a short page', async () => {
    const { adapter, asked, done } = scan([
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [[3, 'c']],
    ])
    const out = await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))
    expect(out).toEqual([
      [
        [1, 'a'],
        [2, 'b'],
      ],
      [[3, 'c']],
    ])
    expect(asked[0]).toEqual({ text: 'SELECT `id`, `name` FROM `shop`.`t` ORDER BY `id` LIMIT ?', params: [2] })
    expect(asked[1]?.text).toBe(
      'SELECT `id`, `name` FROM `shop`.`t` WHERE (`id`) > (CAST(? AS SIGNED)) ORDER BY `id` LIMIT ?'
    )
    expect(asked[1]?.params).toEqual([2, 2])
    expect(asked).toHaveLength(2)
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
    expect(asked).toHaveLength(2)
  })

  it('still yields one empty batch for an empty table, so the caller learns the columns', async () => {
    const { adapter } = scan([[]])
    expect(await collect(adapter.iterateRows(ns, 't', { batchSize: 5, schema: keyed }))).toEqual([[]])
  })

  it('pages over a composite key as a row comparison, in the order of the key', async () => {
    const schema = schemaOf({ columns: [column('a'), column('b'), column('c')], primaryKey: ['b', 'a'] })
    const { adapter, asked } = scan([
      [
        [1, 10, 'x'],
        [2, 20, 'y'],
      ],
      [],
    ])
    await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema }))
    expect(asked[0]?.text).toContain('ORDER BY `b`, `a` LIMIT ?')
    expect(asked[1]?.text).toContain(
      'WHERE (`b`, `a`) > (CAST(? AS SIGNED), CAST(? AS SIGNED)) ORDER BY `b`, `a` LIMIT ?'
    )
    expect(asked[1]?.params).toEqual([20, 2, 2])
  })

  it('compares an enum key as text in binary order, and the lower bound as the same text', async () => {
    const schema = schemaOf({ columns: [column('k', "enum('a','B')")], primaryKey: ['k'] })
    const { adapter, asked } = scan([[['a'], ['B']], []])
    await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema }))
    expect(asked[0]?.text).toContain('ORDER BY CAST(`k` AS CHAR) COLLATE utf8mb4_bin LIMIT ?')
    expect(asked[1]?.text).toContain('WHERE (CAST(`k` AS CHAR) COLLATE utf8mb4_bin) > (')
  })

  it('refuses a key column the schema does not have', async () => {
    const schema = schemaOf({ columns: [column('a')], primaryKey: ['gone'] })
    const { adapter } = scan([])
    await expect(collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema }))).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      message: 'Key column missing from table schema',
    })
  })

  it('treats a batch size below 1 or with a fraction as the whole number it rounds down to, at least 1', async () => {
    for (const [given, used] of [
      [0, 1],
      [-5, 1],
      [2.9, 2],
    ] as const) {
      const { adapter, asked } = scan([[]])
      await collect(adapter.iterateRows(ns, 't', { batchSize: given, schema: keyed }))
      expect(asked[0]?.params, String(given)).toEqual([used])
    }
  })

  it('describes the table itself when it is not given the schema', async () => {
    const { adapter } = scan([[]])
    const describeTable = vi.fn(async () => keyed)
    internals(adapter).describeTable = describeTable
    await collect(adapter.iterateRows(ns, 'orders', { batchSize: 2 }))
    expect(describeTable).toHaveBeenCalledWith(ns, 'orders')
  })

  it('reads times as UTC when asked, and resets the session afterwards, even when the scan fails', async () => {
    const { adapter, asked, reset, done } = scan([[]])
    await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed, utc: true }))
    expect(asked[0]?.text).toBe("SET SESSION time_zone = '+00:00'")
    expect(reset).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledTimes(1)
    const plain = scan([[]])
    await collect(plain.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed }))
    expect(plain.asked.some((q) => q.text.includes('time_zone'))).toBe(false)
    expect(plain.reset).not.toHaveBeenCalled()
    const broken = scan([])
    ;(broken.adapter as unknown as Internals).borrow = async () => ({
      conn: {
        query: async () => {
          throw new Error('boom')
        },
        reset: broken.reset,
      } as unknown as Conn,
      done: broken.done,
    })
    await expect(
      collect(broken.adapter.iterateRows(ns, 't', { batchSize: 2, schema: keyed, utc: true }))
    ).rejects.toThrow('boom')
    expect(broken.reset).toHaveBeenCalledTimes(1)
    expect(broken.done).toHaveBeenCalledTimes(1)
  })

  it('streams a table without a key in one statement, whole, and does not page it', async () => {
    const { adapter, asked, streamed } = scan([], { stream: true })
    const none = schemaOf({ columns: [column('id'), column('name', 'text', true)] })
    const out = await collect(adapter.iterateRows(ns, 't', { batchSize: 50, schema: none }))
    expect(out).toEqual([[[1, 'a']], [[2, 'b']]])
    expect(streamed).toEqual([{ text: 'SELECT `id`, `name` FROM `shop`.`t`', params: [], batch: 50 }])
    expect(asked).toHaveLength(0)
  })

  it('reads a table without a key in one unordered statement when the connection cannot stream', async () => {
    const { adapter, asked } = scan([
      [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ],
    ])
    const none = schemaOf({ columns: [column('id'), column('name', 'text', true)] })
    expect(await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema: none }))).toEqual([
      [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ],
    ])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.text).toBe('SELECT `id`, `name` FROM `shop`.`t`')
    expect(asked[0]?.params).toEqual([])
  })

  it('uses a not-null unique index as the key when there is no primary key', async () => {
    const schema = schemaOf({
      columns: [column('u'), column('n', 'int', true)],
      indexes: [{ unique: true, predicate: null, columns: ['u'] }],
    })
    const { adapter, asked } = scan([[]])
    await collect(adapter.iterateRows(ns, 't', { batchSize: 2, schema }))
    expect(asked[0]?.text).toContain('ORDER BY `u` LIMIT ?')
  })
})

describe('MysqlAdapter: the row stream', () => {
  const FIELD = { name: 'id', columnType: 3, columnLength: 11, flags: 0, characterSet: 63 }
  /** A core connection whose query streams `data`, or fails the stream with `error` after `data`. */
  function core(data: unknown[][], error?: Error) {
    const c = new EventEmitter() as EventEmitter & { query: unknown; stream: { destroy: () => void } }
    const seen: { sql: string; values: unknown[]; rowsAsArray: boolean; highWaterMark?: number }[] = []
    const killed = vi.fn()
    const sockets = vi.fn()
    c.stream = { destroy: sockets }
    let readable: Readable | null = null
    c.query = (q: { sql: string; values: unknown[]; rowsAsArray: boolean }) => {
      seen.push({ ...q })
      const ev = new EventEmitter() as EventEmitter & { stream: (o: { highWaterMark: number }) => Readable }
      ev.stream = (o) => {
        seen[seen.length - 1] = { ...seen[seen.length - 1]!, highWaterMark: o.highWaterMark }
        ev.emit('fields', [FIELD])
        readable = new Readable({
          objectMode: true,
          highWaterMark: o.highWaterMark,
          read() {
            for (const row of data) this.push(row)
            if (error) this.destroy(error)
            else this.push(null)
          },
          destroy(err, cb) {
            killed(err)
            cb(err)
          },
        })
        return readable
      }
      return ev
    }
    return { c, seen, killed, sockets, listeners: () => c.listenerCount('error') }
  }
  const run = (adapter: MysqlAdapter, c: unknown, batch: number, options?: unknown) =>
    internals(adapter).streamRows?.({ connection: c }, 'SELECT id FROM t', [7], batch, options) as AsyncIterable<{
      columns: { name: string }[]
      rows: unknown[][]
    }>
  const brokenOf = (a: MysqlAdapter) => (a as unknown as { broken: WeakSet<object> }).broken

  it('sends the statement with its values, in batches of the size asked, naming the columns on every batch', async () => {
    const f = core([[1], [2], [3], [4], [5]])
    const batches: unknown[][][] = []
    for await (const b of run(new MysqlAdapter(config), f.c, 2)) {
      expect(b.columns.map((x) => x.name)).toEqual(['id'])
      batches.push(b.rows)
    }
    expect(batches).toEqual([[[1], [2]], [[3], [4]], [[5]]])
    expect(f.seen).toEqual([{ sql: 'SELECT id FROM t', values: [7], rowsAsArray: true, highWaterMark: 2 }])
  })

  it('ends with an empty batch when the rows fill the last one exactly, and for an empty result, so the columns are known', async () => {
    const exact = core([[1], [2]])
    const out: unknown[][][] = []
    for await (const b of run(new MysqlAdapter(config), exact.c, 2)) out.push(b.rows)
    expect(out).toEqual([[[1], [2]], []])
    const empty = core([])
    const none: { name: string }[][] = []
    for await (const b of run(new MysqlAdapter(config), empty.c, 2)) none.push(b.columns)
    expect(none).toEqual([[{ name: 'id', dataType: 'int' }]])
  })

  it("stops listening for the connection's errors when the stream ends, and does not break the connection", async () => {
    const f = core([[1]])
    const a = new MysqlAdapter(config)
    for await (const _ of run(a, f.c, 5)) void _
    expect(f.listeners()).toBe(0)
    expect(brokenOf(a).has(f.c)).toBe(false)
    expect(f.sockets).not.toHaveBeenCalled()
  })

  it('drops the socket and breaks the connection when the consumer leaves early', async () => {
    const f = core([[1], [2], [3], [4]])
    const a = new MysqlAdapter(config)
    for await (const _ of run(a, f.c, 2)) {
      void _
      break
    }
    expect(brokenOf(a).has(f.c)).toBe(true)
    expect(f.sockets).toHaveBeenCalledTimes(1)
    expect(f.killed).toHaveBeenCalled()
    expect(f.listeners()).toBe(0)
  })

  it("fails with the stream's error as an adapter error, marking the connection broken only when it was lost", async () => {
    const lost = core([[1]], Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' }))
    const a = new MysqlAdapter(config)
    await expect(
      (async () => {
        for await (const _ of run(a, lost.c, 5)) void _
      })()
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    expect(brokenOf(a).has(lost.c)).toBe(true)
    expect(lost.sockets).not.toHaveBeenCalled()
    const syntax = core([], Object.assign(new Error('syntax'), { code: 'ER_PARSE_ERROR', errno: 1064 }))
    const b = new MysqlAdapter(config)
    await expect(
      (async () => {
        for await (const _ of run(b, syntax.c, 5)) void _
      })()
    ).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    expect(brokenOf(b).has(syntax.c)).toBe(false)
  })

  it("ends the stream with the connection's own error, such as a KILL, instead of waiting for rows that never come", async () => {
    const f = core([])
    const hang = new Readable({
      objectMode: true,
      read() {
        /* never produces a row: the connection must end the wait */
      },
    })
    ;(f.c as unknown as { query: unknown }).query = () => {
      const ev = new EventEmitter() as EventEmitter & { stream: () => Readable }
      ev.stream = () => hang
      return ev
    }
    const a = new MysqlAdapter(config)
    const pending = (async () => {
      for await (const _ of run(a, f.c, 5)) void _
    })()
    await new Promise((r) => setTimeout(r, 5))
    f.c.emit(
      'error',
      Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED', errno: 1317 })
    )
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_FAILED' })
  })

  it('fails at once when the connection was already lost before the query was queued', async () => {
    const f = core([])
    const hang = new Readable({
      objectMode: true,
      read() {
        /* never produces a row: the connection must end the wait */
      },
    })
    ;(f.c as unknown as { query: unknown }).query = () => {
      f.c.emit('error', Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' }))
      const ev = new EventEmitter() as EventEmitter & { stream: () => Readable }
      ev.stream = () => hang
      return ev
    }
    const a = new MysqlAdapter(config)
    await expect(
      (async () => {
        for await (const _ of run(a, f.c, 5)) void _
      })()
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
  })

  it('reads values as wire cells under the options it is given', async () => {
    const f = core([[Buffer.from([1, 2, 3])]])
    const out: unknown[][][] = []
    for await (const b of run(new MysqlAdapter(config), f.c, 5, { binaryLimit: 1 })) out.push(b.rows)
    expect(out[0]?.[0]?.[0]).toMatchObject({ $bin: expect.any(String) })
  })
})

describe('MysqlAdapter: the small session statements', () => {
  const s = (answer: Parameters<typeof rows>[0] = []) => scripted([[/./, rows(answer)]])

  it('caps a result at one more than the rows the console shows, at least 2, whole', async () => {
    const asked = async (max: number) => {
      const c = s()
      expect(await internals(new MysqlAdapter(config)).capResultRows?.(c.conn, max)).toBe(true)
      return c.asked[0]?.text
    }
    expect(await asked(100)).toBe('SET SESSION sql_select_limit = 101')
    expect(await asked(0)).toBe('SET SESSION sql_select_limit = 2')
    expect(await asked(-9)).toBe('SET SESSION sql_select_limit = 2')
    expect(await asked(10.9)).toBe('SET SESSION sql_select_limit = 11')
  })

  it('starts profiling when the server can, and says it cannot when it refuses', async () => {
    const a = new MysqlAdapter(config)
    const ok = s()
    expect(await internals(a).startProfiling?.(ok.conn)).toBe(true)
    expect(ok.asked[0]?.text).toBe('SET SESSION profiling = 1')
    const refused = scripted([[/profiling/, new Error('unknown variable')]])
    expect(await internals(a).startProfiling?.(refused.conn)).toBe(false)
  })

  it('reads the profile as stages with seconds, an empty name or time as empty and 0', async () => {
    const c = s([
      ['starting', '0.000123'],
      [null, null],
      ['end', 2],
    ])
    expect(await internals(new MysqlAdapter(config)).readProfile?.(c.conn)).toEqual([
      { state: 'starting', seconds: 0.000123 },
      { state: '', seconds: 0 },
      { state: 'end', seconds: 2 },
    ])
    expect(c.asked[0]?.text).toBe('SHOW PROFILE')
  })

  it('names the backend by the connection id, empty when the server says nothing', async () => {
    const a = new MysqlAdapter(config)
    const c = s([[4242]])
    expect(await internals(a).backendId?.(c.conn)).toBe('4242')
    expect(c.asked[0]?.text).toBe('SELECT CONNECTION_ID()')
    expect(await internals(a).backendId?.(s([]).conn)).toBe('')
  })

  it('limits statement time in milliseconds with max_execution_time, whole and not below 0', async () => {
    const a = new MysqlAdapter(config)
    const set = async (ms: number) => {
      const c = s()
      await internals(a).setStatementTimeout?.(c.conn, ms)
      return c.asked.map((q) => q.text)
    }
    expect(await set(1500.7)).toEqual(['SET SESSION max_execution_time = 1500'])
    expect(await set(-5)).toEqual(['SET SESSION max_execution_time = 0'])
  })

  it('falls back to max_statement_time in seconds where MariaDB lacks the variable, and remembers it', async () => {
    const a = new MysqlAdapter(config)
    const c = scripted([
      [/max_execution_time/, fail('QUERY_FAILED', 'ER_UNKNOWN_SYSTEM_VARIABLE')],
      [/max_statement_time/, rows([])],
    ])
    await internals(a).setStatementTimeout?.(c.conn, 2500)
    expect(c.asked.map((q) => q.text)).toEqual([
      'SET SESSION max_execution_time = 2500',
      'SET SESSION max_statement_time = 2.5',
    ])
    await internals(a).setStatementTimeout?.(c.conn, 500)
    expect(c.asked.at(-1)?.text).toBe('SET SESSION max_statement_time = 0.5')
    expect(c.asked).toHaveLength(3)
    expect((a as unknown as { timeoutVariable: string }).timeoutVariable).toBe('max_statement_time')
  })

  it('does not hide any other failure of the timeout statement, and does not switch variables for it', async () => {
    const plain = scripted([[/max_execution_time/, new Error('boom')]])
    await expect(internals(new MysqlAdapter(config)).setStatementTimeout?.(plain.conn, 1)).rejects.toThrow('boom')
    const a = new MysqlAdapter(config)
    const denied = scripted([[/max_execution_time/, fail('PERMISSION_DENIED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')]])
    await expect(internals(a).setStatementTimeout?.(denied.conn, 1)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(denied.asked).toHaveLength(1)
    expect((a as unknown as { timeoutVariable: string }).timeoutVariable).toBe('max_execution_time')
  })

  it('has the answers of its dialect: <=> for null-safe equality, all columns as the fallback key, none to select', () => {
    const a = new MysqlAdapter(config)
    expect(internals(a).nullSafeEq?.()).toBe('<=>')
    expect(internals(a).fallbackKeyKind?.()).toBe('all-columns')
    expect(internals(a).fallbackKeySelect?.()).toBeNull()
  })
})
