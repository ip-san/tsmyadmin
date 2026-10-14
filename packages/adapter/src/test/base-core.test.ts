import { describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'
import { rows } from './scripted-conn.ts'

/**
 * The shared base of the adapters: how a connection is checked out with the statement timeout applied once, how a
 * transaction ends, how a table's rows are addressed, and the check for rows whose parent is gone. Each with the
 * connection faked, on a real adapter of each dialect.
 */

const ns = { database: 'd', schema: 'sales' }
type Dialect = 'mysql' | 'postgres'
const make = (dialect: Dialect) => {
  const cfg = { dialect, host: 'h', port: 1, user: 'u', password: 'p' } as const
  return dialect === 'mysql' ? new MysqlAdapter(cfg) : new PostgresAdapter(cfg)
}
type Internals = {
  acquire: unknown
  setStatementTimeout: unknown
  borrow: (ns: unknown, ms: number) => Promise<{ conn: Conn; done: () => Promise<void> }>
  withConn: <T>(ns: unknown, fn: (c: Conn) => Promise<T>, ms?: number) => Promise<T>
  withTransaction: <T>(ns: unknown, fn: (c: Conn) => Promise<T>) => Promise<T>
  forgetSessionState: (c: Conn) => void
}
const inner = (a: unknown) => a as Internals

/** An adapter whose connections are `conns` in turn (the last one repeats), and the timeouts it was asked to set. */
function rig(dialect: Dialect = 'mysql', conns: number = 1) {
  const adapter = make(dialect)
  const log: string[] = []
  const timeouts: number[] = []
  const made = Array.from({ length: conns }, (_, i) => ({
    id: { n: i },
    release: vi.fn(),
    forget: vi.fn(),
    reset: async () => undefined,
    discard: vi.fn(),
    query: vi.fn(async (text: string) => {
      log.push(text)
      return rows([])
    }),
  }))
  let next = 0
  inner(adapter).acquire = async () => made[Math.min(next++, made.length - 1)]
  const failing: { error: Error | null } = { error: null }
  inner(adapter).setStatementTimeout = async (_c: unknown, ms: number) => {
    if (failing.error) throw failing.error
    timeouts.push(ms)
  }
  return {
    adapter,
    conns: made as unknown as (Conn & {
      release: ReturnType<typeof vi.fn>
      forget: ReturnType<typeof vi.fn>
      query: ReturnType<typeof vi.fn>
    })[],
    log,
    timeouts,
    failing,
  }
}

describe('borrow and withConn', () => {
  it('sets the statement timeout on a connection the first time, and not again while it stays the same', async () => {
    const r = rig()
    await inner(r.adapter).borrow(ns, 5000)
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts).toEqual([5000])
    await inner(r.adapter).borrow(ns, 9000)
    expect(r.timeouts).toEqual([5000, 9000])
    await inner(r.adapter).borrow(ns, 9000)
    expect(r.timeouts).toEqual([5000, 9000])
  })

  it('keeps the timeout of each connection apart', async () => {
    const r = rig('mysql', 2)
    await inner(r.adapter).borrow(ns, 5000)
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts).toEqual([5000, 5000])
  })

  it('gives the connection back and does not remember the timeout when setting it fails', async () => {
    const r = rig()
    r.failing.error = new Error('cannot set')
    await expect(inner(r.adapter).borrow(ns, 5000)).rejects.toThrow('cannot set')
    expect(r.conns[0]?.release).toHaveBeenCalledTimes(1)
    r.failing.error = null
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts).toEqual([5000])
    expect(r.conns[0]?.release).toHaveBeenCalledTimes(1)
  })

  it("forgets the timeout and the dialect's own cache after user SQL, so the next borrower sets it again", async () => {
    const r = rig()
    const { conn } = await inner(r.adapter).borrow(ns, 5000)
    inner(r.adapter).forgetSessionState(conn)
    expect(r.conns[0]?.forget).toHaveBeenCalledTimes(1)
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts).toEqual([5000, 5000])
  })

  it('hands the connection to the function, gives it back afterwards, even when the function fails, and answers with its result', async () => {
    const r = rig()
    expect(await inner(r.adapter).withConn(ns, async () => 'result', 1000)).toBe('result')
    expect(r.conns[0]?.release).toHaveBeenCalledTimes(1)
    await expect(inner(r.adapter).withConn(ns, async () => Promise.reject(new Error('boom')), 1000)).rejects.toThrow(
      'boom'
    )
    expect(r.conns[0]?.release).toHaveBeenCalledTimes(2)
  })

  it('applies 30 seconds unless another timeout is given', async () => {
    const r = rig()
    await inner(r.adapter).withConn(ns, async () => undefined)
    expect(r.timeouts).toEqual([30_000])
    await inner(r.adapter).withConn(ns, async () => undefined, 2000)
    expect(r.timeouts).toEqual([30_000, 2000])
  })
})

describe('withTransaction', () => {
  it('begins, runs, commits and answers with the result', async () => {
    const r = rig()
    expect(await inner(r.adapter).withTransaction(ns, async (c) => (await c.query('X'), 'done'))).toBe('done')
    expect(r.log).toEqual(['BEGIN', 'X', 'COMMIT'])
  })

  it('rolls back and passes the failure on, even when the rollback itself fails', async () => {
    const r = rig()
    await expect(inner(r.adapter).withTransaction(ns, async () => Promise.reject(new Error('first')))).rejects.toThrow(
      'first'
    )
    expect(r.log).toEqual(['BEGIN', 'ROLLBACK'])
    const noRollback = rig()
    noRollback.conns[0]?.query.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('rollback failed')
      return rows([])
    })
    await expect(
      inner(noRollback.adapter).withTransaction(ns, async () => Promise.reject(new Error('first')))
    ).rejects.toThrow('first')
  })

  it('does not commit, and rolls back, when the commit fails', async () => {
    const r = rig()
    r.conns[0]?.query.mockImplementation(async (text: string) => {
      r.log.push(text)
      if (text === 'COMMIT') throw new Error('commit failed')
      return rows([])
    })
    await expect(inner(r.adapter).withTransaction(ns, async () => 1)).rejects.toThrow('commit failed')
    expect(r.log).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK'])
  })
})

describe('resolveRowKey', () => {
  const schema = (over: Record<string, unknown>) =>
    ({
      kind: 'table',
      columns: [
        { name: 'a', nullable: false },
        { name: 'b', nullable: true },
        { name: 'c', nullable: false },
      ],
      primaryKey: [],
      indexes: [],
      partitioned: false,
      hasChildren: false,
      ...over,
    }) as never
  const resolve = (dialect: Dialect, s: never) => make(dialect).resolveRowKey(s)
  const unique = (columns: string[], predicate: string | null = null) => ({ unique: true, predicate, columns })

  it('has no key for a view', () => {
    for (const kind of ['view', 'materialized_view']) {
      expect(resolve('mysql', schema({ kind, primaryKey: ['a'] }))).toEqual({ keyKind: 'none', keyColumns: [] })
    }
  })

  it('uses the primary key', () => {
    expect(resolve('mysql', schema({ primaryKey: ['c', 'a'] }))).toEqual({ keyKind: 'pk', keyColumns: ['c', 'a'] })
  })

  it('uses a unique index whose columns are all NOT NULL and whole-table, the first such one', () => {
    const s = schema({
      indexes: [
        unique(['b']),
        unique(['a'], 'a > 0'),
        { unique: false, predicate: null, columns: ['a'] },
        unique(['c', 'a']),
        unique(['a']),
      ],
    })
    expect(resolve('mysql', s)).toEqual({ keyKind: 'pk', keyColumns: ['c', 'a'] })
    expect(resolve('mysql', schema({ indexes: [unique(['a', 'b'])] }))).toEqual({
      keyKind: 'all-columns',
      keyColumns: ['a', 'b', 'c'],
    })
  })

  it('falls back to every column on MySQL and to ctid on PostgreSQL', () => {
    expect(resolve('mysql', schema({}))).toEqual({ keyKind: 'all-columns', keyColumns: ['a', 'b', 'c'] })
    expect(resolve('postgres', schema({}))).toEqual({ keyKind: 'ctid', keyColumns: ['ctid'] })
  })

  it('gives no key to a partitioned table or a parent with children on PostgreSQL, whose ctid repeats, but not on MySQL', () => {
    expect(resolve('postgres', schema({ partitioned: true }))).toEqual({ keyKind: 'none', keyColumns: [] })
    expect(resolve('postgres', schema({ hasChildren: true }))).toEqual({ keyKind: 'none', keyColumns: [] })
    expect(resolve('postgres', schema({ partitioned: true, primaryKey: ['a'] }))).toEqual({
      keyKind: 'pk',
      keyColumns: ['a'],
    })
    expect(resolve('mysql', schema({ partitioned: true }))).toMatchObject({ keyKind: 'all-columns' })
  })
})

describe('checkReferences', () => {
  const NO_ROW = Symbol('no row')
  const fk = (over: Record<string, unknown> = {}) => ({
    name: 'fk1',
    columns: ['a', 'b'],
    refNamespace: { database: 'd', schema: 'sales' },
    refTable: 'parent',
    refColumns: ['x', 'y'],
    ...over,
  })
  const check = async (dialect: Dialect, foreignKeys: unknown[], count: unknown = 3) => {
    const r = rig(dialect)
    ;(r.adapter as unknown as { describeTable: unknown }).describeTable = async () => ({ foreignKeys })
    r.conns[0]?.query.mockImplementation(async (text: string) => {
      r.log.push(text)
      return rows(count === NO_ROW ? [] : [[count]])
    })
    return { out: await r.adapter.checkReferences(ns, 'child'), log: r.log }
  }

  it('counts the rows whose parent is missing, ignoring rows with a NULL in the key, and gives the statement to look at them', async () => {
    const { out, log } = await check('mysql', [fk()], '4')
    expect(out).toEqual([
      {
        name: 'fk1',
        columns: ['a', 'b'],
        refNamespace: { database: 'd', schema: 'sales' },
        refTable: 'parent',
        refColumns: ['x', 'y'],
        orphans: 4,
        sql: 'SELECT c.* FROM `d`.`child` c LEFT JOIN `d`.`parent` p ON c.`a` = p.`x` AND c.`b` = p.`y` WHERE p.`x` IS NULL AND c.`a` IS NOT NULL AND c.`b` IS NOT NULL',
      },
    ])
    expect(log).toEqual([
      'SELECT COUNT(*) FROM `d`.`child` c LEFT JOIN `d`.`parent` p ON c.`a` = p.`x` AND c.`b` = p.`y` WHERE p.`x` IS NULL AND c.`a` IS NOT NULL AND c.`b` IS NOT NULL',
    ])
  })

  it('quotes for PostgreSQL, one entry per foreign key, and none when there are none', async () => {
    const { out, log } = await check('postgres', [
      fk({ columns: ['a'], refColumns: ['x'] }),
      fk({ name: 'fk2', columns: ['b'], refColumns: ['y'] }),
    ])
    expect(out.map((o) => o.name)).toEqual(['fk1', 'fk2'])
    expect(log[0]).toContain(
      'FROM "sales"."child" c LEFT JOIN "sales"."parent" p ON c."a" = p."x" WHERE p."x" IS NULL AND c."a" IS NOT NULL'
    )
    expect((await check('mysql', [])).out).toEqual([])
  })

  it('reads a missing count as none', async () => {
    expect((await check('mysql', [fk()], NO_ROW)).out[0]?.orphans).toBe(0)
    expect((await check('mysql', [fk()], null)).out[0]?.orphans).toBe(0)
  })
})

describe('the hooks of the condition builders', () => {
  it('compares a MySQL row by every column with <=>, and a text column as exact bytes', async () => {
    const r = rig('mysql')
    ;(r.adapter as unknown as { describeTable: unknown }).describeTable = async () => ({
      columns: [{ name: 'a', dataType: 'varchar(5)' }],
    })
    r.conns[0]?.query.mockImplementation(async (text: string) => {
      r.log.push(text)
      return { ...rows([]), affectedRows: 1 }
    })
    await r.adapter.deleteRows(ns, 't', [{ kind: 'all-columns', values: { a: 'x' } }] as never)
    expect(r.log.find((q) => q.startsWith('DELETE'))).toMatch(/<=>/)
    expect(r.log.find((q) => q.startsWith('DELETE'))).toMatch(/BINARY/i)
  })

  it('asks the table for its column types on MySQL, which casts keys, and not on PostgreSQL, which does not', async () => {
    for (const [dialect, calls] of [
      ['mysql', 1],
      ['postgres', 0],
    ] as const) {
      const r = rig(dialect)
      const describe = vi.fn(async () => ({ columns: [{ name: 'id', dataType: 'int' }] }))
      ;(r.adapter as unknown as { describeTable: unknown }).describeTable = describe
      r.conns[0]?.query.mockImplementation(async () => ({ ...rows([]), affectedRows: 1 }))
      await r.adapter.deleteRows(ns, 't', [{ kind: 'pk', values: { id: 1 } }] as never)
      expect(describe, dialect).toHaveBeenCalledTimes(calls)
    }
  })
})
