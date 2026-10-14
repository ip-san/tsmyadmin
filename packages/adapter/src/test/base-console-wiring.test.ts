import { describe, expect, it, vi } from 'vitest'
import type { Conn } from '../driver.ts'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'
import { rows } from './scripted-conn.ts'

/**
 * How the base wires the SQL console to the dialect: a run through `executeSql` on a real adapter of each dialect,
 * with only `acquire` faked, must set the dialect's row cap, time its stages where the server can, publish the
 * server-side id a cancel is sent to, map the driver's errors, and forget the session it may have changed.
 */

const ns = { database: 'd', schema: 'sales' }
type Dialect = 'mysql' | 'postgres'
const EXEC = { maxRows: 10, timeoutMs: 1000, stopOnError: true }

function rig(dialect: Dialect, answer: (text: string) => unknown = () => rows([])) {
  const cfg = { dialect, host: 'h', port: 1, user: 'u', password: 'p' } as const
  const adapter = dialect === 'mysql' ? new MysqlAdapter(cfg) : new PostgresAdapter(cfg)
  const asked: string[] = []
  const conn = {
    id: {},
    release: vi.fn(),
    forget: vi.fn(),
    reset: vi.fn(async () => undefined),
    discard: vi.fn(),
    query: vi.fn(async (text: string) => {
      asked.push(text)
      const out = answer(text)
      if (out instanceof Error) throw out
      return out
    }),
  }
  ;(adapter as unknown as { acquire: unknown }).acquire = async () => conn
  const canceller = { cancel: vi.fn(async (_id: string) => undefined), close: vi.fn(async () => undefined) }
  ;(adapter as unknown as { openCanceller: unknown }).openCanceller = async () => canceller
  return { adapter, asked, conn: conn as unknown as Conn & typeof conn, canceller }
}

describe('executeSql on MySQL', () => {
  it('caps the session at one row more than shown, sets the statement time, and publishes the connection id, before the first statement', async () => {
    const r = rig('mysql', (t) => (t === 'SELECT CONNECTION_ID()' ? rows([[4242]]) : rows([[1]], ['a'])))
    await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, queryId: 'q' })
    const first = r.asked.indexOf('SELECT 1')
    expect(r.asked.slice(0, first)).toEqual([
      'SET SESSION max_execution_time = 1000',
      'SET SESSION sql_select_limit = 11',
      'SELECT CONNECTION_ID()',
    ])
  })

  it('does not wrap a read, since the session is capped, and does not ask for the connection id without a query id', async () => {
    const r = rig('mysql', () => rows([[1]], ['a']))
    await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(r.asked).toContain('SELECT 1')
    expect(r.asked.some((t) => t.startsWith('SELECT * FROM ('))).toBe(false)
    expect(r.asked).not.toContain('SELECT CONNECTION_ID()')
  })

  it('times the stages of each statement when asked, and attaches them to its result', async () => {
    const r = rig('mysql', (t) =>
      t === 'SHOW PROFILE'
        ? rows([
            ['starting', '0.001'],
            ['end', 0.5],
          ])
        : rows([[1]], ['a'])
    )
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, profile: true })
    expect(r.asked.indexOf('SET SESSION profiling = 1')).toBeLessThan(r.asked.indexOf('SELECT 1'))
    expect(r.asked.indexOf('SHOW PROFILE')).toBeGreaterThan(r.asked.indexOf('SELECT 1'))
    expect(result).toMatchObject({
      profile: [
        { state: 'starting', seconds: 0.001 },
        { state: 'end', seconds: 0.5 },
      ],
    })
    const plain = rig('mysql', () => rows([[1]], ['a']))
    await plain.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(plain.asked).not.toContain('SET SESSION profiling = 1')
    expect(plain.asked).not.toContain('SHOW PROFILE')
  })

  it("reports an error the driver threw with the dialect's own reading of it", async () => {
    const r = rig('mysql', (t) =>
      t === 'SELECT 1'
        ? Object.assign(new Error('nope'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR', errno: 1227 })
        : rows([])
    )
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(result).toMatchObject({
      kind: 'error',
      code: 'PERMISSION_DENIED',
      nativeCode: 'ER_SPECIFIC_ACCESS_DENIED_ERROR',
    })
  })

  it('sends a cancel to the id the connection reported, and reports the run as cancelled', async () => {
    let release: () => void = () => undefined
    const hang = new Promise<ReturnType<typeof rows>>((resolve) => {
      release = () => resolve(rows([[1]], ['a']))
    })
    const r = rig('mysql', (t) =>
      t === 'SELECT CONNECTION_ID()' ? rows([['77']]) : t === 'SELECT SLEEP(5)' ? hang : rows([])
    )
    const run = r.adapter.executeSql(ns, 'SELECT SLEEP(5)', { ...EXEC, queryId: 'q', stopOnError: false })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const cancelled = r.adapter.cancelQuery('q')
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    expect(await cancelled).toBe(true)
    await run
    expect(r.canceller.cancel).toHaveBeenCalledWith('77')
    expect(r.conn.discard).toHaveBeenCalled()
  })

  it('forgets the statement time the run may have changed, so the next borrower sets it again', async () => {
    const r = rig('mysql', () => rows([[1]], ['a']))
    await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(r.conn.forget).toHaveBeenCalled()
    r.asked.length = 0
    await r.adapter.countRows(ns, 't')
    expect(r.asked[0]).toBe('SET SESSION max_execution_time = 30000')
  })

  it('sets the statement time again after a change of it failed on a connection that had one', async () => {
    const r = rig('mysql', (t) =>
      t === 'SET SESSION max_execution_time = 5' ? Object.assign(new Error('x'), { code: 'ER_X' }) : rows([[1]])
    )
    await r.adapter.countRows(ns, 't')
    await expect(r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, timeoutMs: 5 })).rejects.toBeDefined()
    expect(r.conn.release).toHaveBeenCalledTimes(2)
    r.asked.length = 0
    await r.adapter.countRows(ns, 't')
    expect(r.asked[0]).toBe('SET SESSION max_execution_time = 30000')
  })
})

describe('executeSql on PostgreSQL', () => {
  it('wraps a read with the row cap, since the session cannot be capped, and publishes the backend id', async () => {
    const r = rig('postgres', (t) => (t === 'SELECT pg_backend_pid()' ? rows([[99]]) : rows([[1]], ['a'])))
    await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, queryId: 'q' })
    expect(r.asked.slice(0, 2)).toEqual(['SET statement_timeout = 1000', 'SELECT pg_backend_pid()'])
    expect(r.asked.some((t) => t.startsWith('SELECT * FROM (') && t.includes('LIMIT 11'))).toBe(true)
    expect(r.asked.some((t) => t.includes('sql_select_limit'))).toBe(false)
  })

  it('has no stages to time: profiling is asked of the server nowhere, and no result carries a profile', async () => {
    const r = rig('postgres', () => rows([[1]], ['a']))
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, profile: true })
    expect(r.asked.some((t) => /profil/i.test(t))).toBe(false)
    expect(result).not.toHaveProperty('profile')
  })

  it("reports an error the driver threw with the dialect's own reading of it", async () => {
    const r = rig('postgres', (t) =>
      t.includes('SELECT 1') ? Object.assign(new Error('denied'), { code: '42501' }) : rows([])
    )
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(result).toMatchObject({ kind: 'error', code: 'PERMISSION_DENIED', nativeCode: '42501' })
  })

  it('keeps a statement that changed no rows whole for a streaming consumer, with no result field added', async () => {
    const r = rig('postgres', () => ({ ...rows([]), affectedRows: 3, hasRows: false }))
    const seen: unknown[] = []
    const [kept] = await r.adapter.executeSql(ns, 'UPDATE t SET a = 1', { ...EXEC, onResult: (x) => void seen.push(x) })
    expect(kept).not.toHaveProperty('result')
    expect(seen[0]).toEqual(kept)
  })
})
