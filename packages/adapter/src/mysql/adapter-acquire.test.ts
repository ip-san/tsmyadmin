import { describe, expect, it } from 'vitest'
import type { Conn } from '../driver.ts'
import { MysqlAdapter } from './adapter.ts'

/**
 * How the MySQL adapter sets a pooled connection up for a call (`acquire`), with the pool's connection faked:
 * the server's kind, the database in use, the session mode, the reset between users and the open-transaction probe.
 */

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'p' }
type Reply = (sql: string) => unknown
type Fake = { core: object; sent: string[]; released: number; destroyed: number; resets: number; conn: unknown }

/** A pool connection answering by `reply` (a thrown value fails the statement); results are `[rows, fields]`. */
function fakeConnection(reply: Reply = () => [[], []], resetFails = false): Fake {
  const core = {}
  const f: Fake = { core, sent: [], released: 0, destroyed: 0, resets: 0, conn: null }
  f.conn = {
    connection: core,
    query: async (q: string | { sql: string }) => {
      const sql = typeof q === 'string' ? q : q.sql
      f.sent.push(sql)
      const out = reply(sql)
      if (out instanceof Error) throw out
      return out
    },
    release: () => void f.released++,
    destroy: () => void f.destroyed++,
    reset: async () => {
      f.resets++
      if (resetFails) throw new Error('cannot reset')
    },
  }
  return f
}
const header = [{ affectedRows: 0 }, undefined]
const version = (text: string) => (sql: string) =>
  sql === 'SELECT VERSION()'
    ? [[[text]], [{ name: 'v', columnType: 253, columnLength: 10, flags: 0, characterSet: 224 }]]
    : header

const adapterWith = (...fakes: Fake[]) => {
  const a = new MysqlAdapter(config)
  let next = 0
  ;(a as unknown as { getConnection: () => Promise<unknown> }).getConnection = async () => fakes[next++]?.conn
  return a
}
const acquire = (a: MysqlAdapter, database = 'shop') =>
  (a as unknown as { acquire: (ns: unknown) => Promise<Conn> }).acquire({ database })
const mariadbOf = (a: MysqlAdapter) => (a as unknown as { mariadb: boolean | null }).mariadb

describe('MysqlAdapter.acquire: setting a connection up', () => {
  it('learns once whether the server is MariaDB, and says so for every later connection', async () => {
    const f1 = fakeConnection(version('10.11.2-MariaDB-1'))
    const f2 = fakeConnection(version('10.11.2-MariaDB-1'))
    const a = adapterWith(f1, f2)
    await acquire(a)
    expect(mariadbOf(a)).toBe(true)
    await acquire(a)
    expect(f1.sent.filter((s) => s === 'SELECT VERSION()')).toHaveLength(1)
    expect(f2.sent).not.toContain('SELECT VERSION()')
    const mysql = adapterWith(fakeConnection(version('8.0.36')))
    await acquire(mysql)
    expect(mariadbOf(mysql)).toBe(false)
    const upper = adapterWith(fakeConnection(version('10.5.0-MARIADB')))
    await acquire(upper)
    expect(mariadbOf(upper)).toBe(true)
    // A version it cannot read (no row, a null) is not MariaDB.
    for (const answer of [[], [[null]]]) {
      const unread = adapterWith(fakeConnection((sql) => (sql === 'SELECT VERSION()' ? [answer, []] : header)))
      await acquire(unread)
      expect(mariadbOf(unread), JSON.stringify(answer)).toBe(false)
    }
  })

  it('switches to the database with the session mode, and on MySQL turns the statistics cache off, in that order', async () => {
    const f = fakeConnection(version('8.0.36'))
    await acquire(adapterWith(f), 'we`ird')
    expect(f.sent).toEqual([
      'SELECT VERSION()',
      'USE `we``ird`',
      expect.stringMatching(/^SET SESSION sql_mode = TRIM\(BOTH ',' FROM REPLACE\(/),
      'SET SESSION information_schema_stats_expiry = 0',
    ])
  })

  it('does not ask MariaDB for the statistics variable it lacks', async () => {
    const f = fakeConnection(version('10.11.2-MariaDB'))
    await acquire(adapterWith(f))
    expect(f.sent.some((s) => s.includes('information_schema_stats_expiry'))).toBe(false)
  })

  it('goes on when an older MySQL does not know the statistics variable, and fails on any other error', async () => {
    const unknownVariable = Object.assign(new Error('Unknown system variable'), {
      code: 'ER_UNKNOWN_SYSTEM_VARIABLE',
      errno: 1193,
    })
    const old = fakeConnection((sql) => (sql.includes('stats_expiry') ? unknownVariable : version('5.7.40')(sql)))
    const conn = await acquire(adapterWith(old))
    expect(conn.id).toBe(old.core)
    expect(old.sent.at(-1)).toBe('SET SESSION information_schema_stats_expiry = 0')
    expect(old.released).toBe(0)
    const denied = Object.assign(new Error('nope'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR', errno: 1227 })
    const bad = fakeConnection((sql) => (sql.includes('stats_expiry') ? denied : version('8.0.36')(sql)))
    await expect(acquire(adapterWith(bad))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(bad.released).toBe(1)
  })

  it('does not set up a connection again for the database it is already in, and does for another one', async () => {
    const f = fakeConnection(version('8.0.36'))
    const a = adapterWith(f, f, f)
    ;(await acquire(a, 'one')).release()
    const before = f.sent.length
    await acquire(a, 'one')
    expect(f.sent).toHaveLength(before)
    await acquire(a, 'two')
    expect(f.sent.slice(before)[0]).toBe('USE `two`')
  })

  it('gives the connection back, and forgets its database, when setting it up fails', async () => {
    // The first USE fails; the database must not be remembered as set up, so the next acquire sends USE again.
    let uses = 0
    const f = fakeConnection((sql) =>
      sql.startsWith('USE') && ++uses === 1
        ? Object.assign(new Error('Unknown database'), { code: 'ER_BAD_DB_ERROR', errno: 1049 })
        : version('8.0.36')(sql)
    )
    const a = adapterWith(f, f)
    await expect(acquire(a, 'one')).rejects.toMatchObject({ code: 'NOT_FOUND', nativeCode: 'ER_BAD_DB_ERROR' })
    expect([f.released, f.destroyed]).toEqual([1, 0])
    await acquire(a, 'one')
    expect(f.sent.filter((s) => s === 'USE `one`')).toHaveLength(2)
    // A connection lost during the setup is destroyed rather than returned to the pool.
    const failing = fakeConnection(() => Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' }))
    await expect(acquire(adapterWith(failing))).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    expect([failing.released, failing.destroyed]).toEqual([0, 1])
  })

  it('reports a pool that gave no connection as an adapter error', async () => {
    const a = new MysqlAdapter(config)
    ;(a as unknown as { getConnection: () => Promise<never> }).getConnection = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    await expect(acquire(a)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
  })
})

describe('MysqlAdapter.acquire: the connection it hands out', () => {
  const ready = async (reply?: Reply, resetFails = false, collation?: string) => {
    const f = fakeConnection(
      (sql) => (sql === 'SELECT VERSION()' ? version('8.0.36')(sql) : (reply?.(sql) ?? header)),
      resetFails
    )
    const a = new MysqlAdapter(collation ? { ...config, collation } : config)
    ;(a as unknown as { getConnection: () => Promise<unknown> }).getConnection = async () => f.conn
    return { f, a, conn: await acquire(a) }
  }

  it('releases to the pool, or destroys when the connection was marked broken', async () => {
    const ok = await ready()
    ok.conn.release()
    expect([ok.f.released, ok.f.destroyed]).toEqual([1, 0])
    const bad = await ready()
    bad.conn.discard()
    bad.conn.release()
    expect([bad.f.released, bad.f.destroyed]).toEqual([0, 1])
    expect(bad.conn.id).toBe(bad.f.core)
  })

  it('marks a connection broken when a statement fails because the connection was lost, not for another failure', async () => {
    const lost = await ready((sql) =>
      sql === 'SELECT 1' ? Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' }) : header
    )
    await expect(lost.conn.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    lost.conn.release()
    expect(lost.f.destroyed).toBe(1)
    const syntax = await ready((sql) =>
      sql === 'SELEC' ? Object.assign(new Error('syntax'), { code: 'ER_PARSE_ERROR', errno: 1064 }) : header
    )
    await expect(syntax.conn.query('SELEC')).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    syntax.conn.release()
    expect([syntax.f.released, syntax.f.destroyed]).toEqual([1, 0])
  })

  it('sends parameters as values and reads rows as arrays, a statement without parameters having none', async () => {
    const sent: unknown[] = []
    const { f, conn } = await ready()
    ;(f.conn as { query: (q: unknown) => Promise<unknown> }).query = async (q) => {
      sent.push(q)
      return header
    }
    await conn.query('SELECT 1')
    await conn.query('SELECT ?', [5])
    expect(sent).toEqual([
      { sql: 'SELECT 1', rowsAsArray: true },
      { sql: 'SELECT ?', values: [5], rowsAsArray: true },
    ])
  })

  it('resets the session between users and sets the handshake collation again, or gives the connection up when it cannot', async () => {
    const ok = await ready(undefined, false, 'latin1_swedish_ci')
    await ok.conn.reset?.()
    expect(ok.f.resets).toBe(1)
    expect(ok.f.sent.at(-1)).toBe('SET NAMES latin1 COLLATE latin1_swedish_ci')
    ok.conn.release()
    expect(ok.f.destroyed).toBe(0)
    const dflt = await ready()
    await dflt.conn.reset?.()
    expect(dflt.f.sent.at(-1)).toBe('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci')
    const bad = await ready(undefined, true)
    await bad.conn.reset?.()
    bad.conn.release()
    expect(bad.f.destroyed).toBe(1)
  })

  it('forgets the database on a reset, so the next call sets it up again', async () => {
    const f = fakeConnection(version('8.0.36'))
    const a = adapterWith(f, f)
    const conn = await acquire(a, 'one')
    await conn.reset?.()
    const before = f.sent.length
    await acquire(a, 'one')
    expect(f.sent.slice(before)[0]).toBe('USE `one`')
  })

  it('tells an open transaction by the lowest bit of the server status, and retries a probe a cancel interrupted once', async () => {
    const status = (n: number | undefined) => (sql: string) =>
      sql === 'DO 0' ? [{ serverStatus: n }, undefined] : header
    for (const [n, open] of [
      [1, true],
      [3, true],
      [2, false],
      [0, false],
      [undefined, false],
    ] as const) {
      const r = await ready(status(n))
      expect(await r.conn.inTransaction?.(), String(n)).toBe(open)
    }
    let calls = 0
    const interrupted = await ready((sql) => {
      if (sql !== 'DO 0') return header
      return ++calls === 1
        ? Object.assign(new Error('interrupted'), { code: 'ER_QUERY_INTERRUPTED' })
        : [{ serverStatus: 1 }, undefined]
    })
    expect(await interrupted.conn.inTransaction?.()).toBe(true)
    expect(calls).toBe(2)
    let again = 0
    const twice = await ready((sql) =>
      sql === 'DO 0' ? (++again, Object.assign(new Error('interrupted'), { code: 'ER_QUERY_INTERRUPTED' })) : header
    )
    await expect(twice.conn.inTransaction?.()).rejects.toMatchObject({ code: 'ER_QUERY_INTERRUPTED' })
    expect(again).toBe(2)
    let otherProbes = 0
    const other = await ready((sql) =>
      sql === 'DO 0' ? (++otherProbes, Object.assign(new Error('x'), { code: 'ER_OTHER' })) : header
    )
    await expect(other.conn.inTransaction?.()).rejects.toMatchObject({ code: 'ER_OTHER' })
    expect(otherProbes).toBe(1)
  })

  it('gives the connection up on a reset when the collation is only a character set, which SET NAMES would refuse', async () => {
    const r = await ready(undefined, false, 'utf8mb4')
    await r.conn.reset?.()
    r.conn.release()
    expect(r.f.destroyed).toBe(1)
    expect(r.f.sent.some((s) => s.startsWith('SET NAMES'))).toBe(false)
  })
})
