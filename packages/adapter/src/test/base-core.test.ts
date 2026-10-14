import { describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'
import { affecting, column, type Dialect, ns, rig } from './base-rig.ts'
import { rows } from './scripted-conn.ts'

/**
 * The shared base of the adapters: how a connection is checked out with the statement timeout applied once, how a
 * transaction ends, how a table's rows are addressed, and the check for rows whose parent is gone. Each with the
 * connection faked, on a real adapter of each dialect.
 */

const make = (dialect: Dialect) => {
  const cfg = { dialect, host: 'h', port: 1, user: 'u', password: 'p' } as const
  return dialect === 'mysql' ? new MysqlAdapter(cfg) : new PostgresAdapter(cfg)
}
type Internals = {
  borrow: (ns: unknown, ms: number) => Promise<{ conn: Conn; done: () => Promise<void> }>
  withConn: <T>(ns: unknown, fn: (c: Conn) => Promise<T>, ms?: number) => Promise<T>
  withTransaction: <T>(ns: unknown, fn: (c: Conn) => Promise<T>) => Promise<T>
  forgetSessionState: (c: Conn) => void
}
const inner = (a: unknown) => a as Internals
const SET_TIMEOUT = 'SET SESSION max_execution_time = 30000'

describe('borrow and withConn', () => {
  it('sets the statement timeout on a connection the first time, and not again while it stays the same', async () => {
    const r = rig('mysql')
    await inner(r.adapter).borrow(ns, 5000)
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts()).toEqual([5000])
    await inner(r.adapter).borrow(ns, 9000)
    expect(r.timeouts()).toEqual([5000, 9000])
    await inner(r.adapter).borrow(ns, 9000)
    expect(r.timeouts()).toEqual([5000, 9000])
  })

  it('keeps the timeout of each connection apart', async () => {
    const r = rig('mysql', { conns: 2 })
    await inner(r.adapter).borrow(ns, 5000)
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts()).toEqual([5000, 5000])
  })

  it('gives the connection back and does not remember the timeout when setting it fails', async () => {
    let failing: Error | null = new Error('cannot set')
    const r = rig('mysql', {
      rules: (text) => (text.startsWith('SET SESSION max_execution_time') && failing) || undefined,
    })
    await expect(inner(r.adapter).borrow(ns, 5000)).rejects.toThrow('cannot set')
    expect(r.conn.release).toHaveBeenCalledTimes(1)
    failing = null
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts()).toEqual([5000, 5000])
    expect(r.conn.release).toHaveBeenCalledTimes(1)
  })

  it("forgets the timeout and the dialect's own cache after user SQL, so the next borrower sets it again", async () => {
    const r = rig('mysql')
    const { conn } = await inner(r.adapter).borrow(ns, 5000)
    inner(r.adapter).forgetSessionState(conn)
    expect(r.conn.forget).toHaveBeenCalledTimes(1)
    await inner(r.adapter).borrow(ns, 5000)
    expect(r.timeouts()).toEqual([5000, 5000])
  })

  it('hands the connection to the function, gives it back afterwards, even when the function fails, and answers with its result', async () => {
    const r = rig('mysql')
    expect(await inner(r.adapter).withConn(ns, async () => 'result', 1000)).toBe('result')
    expect(r.conn.release).toHaveBeenCalledTimes(1)
    await expect(inner(r.adapter).withConn(ns, async () => Promise.reject(new Error('boom')), 1000)).rejects.toThrow(
      'boom'
    )
    expect(r.conn.release).toHaveBeenCalledTimes(2)
  })

  it('applies 30 seconds unless another timeout is given', async () => {
    const r = rig('mysql')
    await inner(r.adapter).withConn(ns, async () => undefined)
    expect(r.timeouts()).toEqual([30_000])
    await inner(r.adapter).withConn(ns, async () => undefined, 2000)
    expect(r.timeouts()).toEqual([30_000, 2000])
  })
})

describe('withTransaction', () => {
  const X: [RegExp, ReturnType<typeof rows>] = [/^X$/, rows([])]

  it('begins, runs, commits and answers with the result', async () => {
    const r = rig('mysql', { rules: [X] })
    expect(await inner(r.adapter).withTransaction(ns, async (c) => (await c.query('X'), 'done'))).toBe('done')
    expect(r.statements()).toEqual([SET_TIMEOUT, 'BEGIN', 'X', 'COMMIT'])
  })

  it('rolls back and passes the failure on, even when the rollback itself fails', async () => {
    const r = rig('mysql')
    await expect(inner(r.adapter).withTransaction(ns, async () => Promise.reject(new Error('first')))).rejects.toThrow(
      'first'
    )
    expect(r.statements()).toEqual([SET_TIMEOUT, 'BEGIN', 'ROLLBACK'])
    const noRollback = rig('mysql', { rules: [[/^ROLLBACK$/, new Error('rollback failed')]] })
    await expect(
      inner(noRollback.adapter).withTransaction(ns, async () => Promise.reject(new Error('first')))
    ).rejects.toThrow('first')
    expect(noRollback.statements()).toEqual([SET_TIMEOUT, 'BEGIN', 'ROLLBACK'])
  })

  it('rolls back after a COMMIT that failed, and passes that failure on', async () => {
    const r = rig('mysql', { rules: [[/^COMMIT$/, new Error('commit failed')]] })
    await expect(inner(r.adapter).withTransaction(ns, async () => 1)).rejects.toThrow('commit failed')
    expect(r.statements()).toEqual([SET_TIMEOUT, 'BEGIN', 'COMMIT', 'ROLLBACK'])
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
    onUpdate: null,
    onDelete: null,
    ...over,
  })
  const check = async (dialect: Dialect, foreignKeys: ReturnType<typeof fk>[], count: unknown = 3) => {
    const r = rig(dialect, {
      rules: [[/COUNT/, rows(count === NO_ROW ? [] : [[count]])]],
      table: { foreignKeys },
    })
    return { out: await r.adapter.checkReferences(ns, 'child'), asked: r.asked.map((q) => q.text) }
  }

  it('counts the rows whose parent is missing, ignoring rows with a NULL in the key, and gives the statement to look at them', async () => {
    const { out, asked } = await check('mysql', [fk()], '4')
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
    expect(asked).toEqual([
      'SELECT COUNT(*) FROM `d`.`child` c LEFT JOIN `d`.`parent` p ON c.`a` = p.`x` AND c.`b` = p.`y` WHERE p.`x` IS NULL AND c.`a` IS NOT NULL AND c.`b` IS NOT NULL',
    ])
  })

  it('quotes for PostgreSQL, one entry per foreign key, and none when there are none', async () => {
    const { out, asked } = await check('postgres', [
      fk({ columns: ['a'], refColumns: ['x'] }),
      fk({ name: 'fk2', columns: ['b'], refColumns: ['y'] }),
    ])
    expect(out.map((o) => o.name)).toEqual(['fk1', 'fk2'])
    expect(asked[0]).toContain(
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
    const r = rig('mysql', { rules: [[/^DELETE/, affecting(1)]], table: { columns: [column('a', 'varchar(5)')] } })
    await r.adapter.deleteRows(ns, 't', [{ kind: 'all-columns', values: { a: 'x' } }])
    expect(r.asked[0]?.text).toMatch(/<=>/)
    expect(r.asked[0]?.text).toMatch(/BINARY/i)
  })

  it('asks the table for its column types on MySQL, which casts keys, and not on PostgreSQL, which does not', async () => {
    for (const [dialect, calls] of [
      ['mysql', 1],
      ['postgres', 0],
    ] as const) {
      const describe = vi.fn(() => ({ columns: [column('id', 'int')] }))
      const r = rig(dialect, { rules: [[/^DELETE/, affecting(1)]], table: describe })
      await r.adapter.deleteRows(ns, 't', [{ kind: 'pk', values: { id: 1 } }])
      expect(describe, dialect).toHaveBeenCalledTimes(calls)
    }
  })
})
