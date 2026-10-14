import { describe, expect, it } from 'vitest'
import { type Dialect, ns, rig } from './base-rig.ts'
import { rows, until } from './scripted-conn.ts'

/**
 * How the base wires the SQL console to the dialect: a run through `executeSql` on a real adapter of each dialect,
 * with only `acquire` faked, must set the dialect's row cap, time its stages where the server can, publish the
 * server-side id a cancel is sent to, map the driver's errors, and forget the session it may have changed.
 */

const EXEC = { maxRows: 10, timeoutMs: 1000, stopOnError: true }
const wired = (dialect: Dialect, answer: (text: string) => ReturnType<typeof rows> | Error | Promise<never>) =>
  rig(dialect, { rules: answer })

describe('executeSql on MySQL', () => {
  it('caps the session at one row more than shown, sets the statement time, and publishes the connection id, before the first statement', async () => {
    const r = wired('mysql', (t) => (t === 'SELECT CONNECTION_ID()' ? rows([[4242]]) : rows([[1]], ['a'])))
    await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, queryId: 'q' })
    const sent = r.statements()
    expect(sent.slice(0, sent.indexOf('SELECT 1'))).toEqual([
      'SET SESSION max_execution_time = 1000',
      'SET SESSION sql_select_limit = 11',
      'SELECT CONNECTION_ID()',
    ])
  })

  it('does not wrap a read, since the session is capped, and does not ask for the connection id without a query id', async () => {
    const r = wired('mysql', () => rows([[1]], ['a']))
    await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(r.statements()).toContain('SELECT 1')
    expect(r.statements().some((t) => t.startsWith('SELECT * FROM ('))).toBe(false)
    expect(r.statements()).not.toContain('SELECT CONNECTION_ID()')
  })

  it('times the stages of each statement when asked, and attaches them to its result', async () => {
    const r = wired('mysql', (t) =>
      t === 'SHOW PROFILE'
        ? rows([
            ['starting', '0.001'],
            ['end', 0.5],
          ])
        : rows([[1]], ['a'])
    )
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, profile: true })
    const sent = r.statements()
    expect(sent.indexOf('SET SESSION profiling = 1')).toBeLessThan(sent.indexOf('SELECT 1'))
    expect(sent.indexOf('SHOW PROFILE')).toBeGreaterThan(sent.indexOf('SELECT 1'))
    expect(result).toMatchObject({
      profile: [
        { state: 'starting', seconds: 0.001 },
        { state: 'end', seconds: 0.5 },
      ],
    })
    const plain = wired('mysql', () => rows([[1]], ['a']))
    await plain.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(plain.statements()).not.toContain('SET SESSION profiling = 1')
    expect(plain.statements()).not.toContain('SHOW PROFILE')
  })

  it("reports an error the driver threw with the dialect's own reading of it", async () => {
    const r = wired('mysql', (t) =>
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
    const hang = new Promise<never>((resolve) => {
      release = () => resolve(rows([[1]], ['a']) as never)
    })
    const r = wired('mysql', (t) =>
      t === 'SELECT CONNECTION_ID()' ? rows([['77']]) : t === 'SELECT SLEEP(5)' ? hang : rows([])
    )
    const run = r.adapter.executeSql(ns, 'SELECT SLEEP(5)', { ...EXEC, queryId: 'q', stopOnError: false })
    await until(() => r.statements().includes('SELECT SLEEP(5)'))
    const cancelled = r.adapter.cancelQuery('q')
    await until(() => r.canceller.cancel.mock.calls.length > 0)
    release()
    expect(await cancelled).toBe(true)
    await run
    expect(r.canceller.cancel).toHaveBeenCalledWith('77')
    expect(r.conn.discard).toHaveBeenCalled()
  })

  it('forgets the statement time the run may have changed, so the next borrower sets it again', async () => {
    const r = wired('mysql', () => rows([[1]], ['a']))
    await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(r.conn.forget).toHaveBeenCalled()
    r.sent.length = 0
    await r.adapter.countRows(ns, 't')
    expect(r.statements()[0]).toBe('SET SESSION max_execution_time = 30000')
  })

  it('sets the statement time again after a change of it failed on a connection that had one', async () => {
    const r = wired('mysql', (t) =>
      t === 'SET SESSION max_execution_time = 5' ? Object.assign(new Error('x'), { code: 'ER_X' }) : rows([[1]])
    )
    await r.adapter.countRows(ns, 't')
    await expect(r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, timeoutMs: 5 })).rejects.toThrow('x')
    expect(r.statements().at(-1)).toBe('SET SESSION max_execution_time = 5')
    expect(r.conn.release).toHaveBeenCalledTimes(2)
    r.sent.length = 0
    await r.adapter.countRows(ns, 't')
    expect(r.statements()[0]).toBe('SET SESSION max_execution_time = 30000')
  })
})

describe('executeSql on PostgreSQL', () => {
  it('wraps a read with the row cap, since the session cannot be capped, and publishes the backend id', async () => {
    const r = wired('postgres', (t) => (t === 'SELECT pg_backend_pid()' ? rows([[99]]) : rows([[1]], ['a'])))
    await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, queryId: 'q' })
    const sent = r.statements()
    expect(sent.slice(0, 2)).toEqual(['SET statement_timeout = 1000', 'SELECT pg_backend_pid()'])
    expect(sent.some((t) => t.startsWith('SELECT * FROM (') && t.includes('LIMIT 11'))).toBe(true)
    expect(sent.some((t) => t.includes('sql_select_limit'))).toBe(false)
  })

  it('has no stages to time: profiling is asked of the server nowhere, and no result carries a profile', async () => {
    const r = wired('postgres', () => rows([[1]], ['a']))
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', { ...EXEC, profile: true })
    expect(r.statements().some((t) => /profil/i.test(t))).toBe(false)
    expect(result).not.toHaveProperty('profile')
  })

  it("reports an error the driver threw with the dialect's own reading of it", async () => {
    const r = wired('postgres', (t) =>
      t.includes('SELECT 1') ? Object.assign(new Error('denied'), { code: '42501' }) : rows([])
    )
    const [result] = await r.adapter.executeSql(ns, 'SELECT 1', EXEC)
    expect(result).toMatchObject({ kind: 'error', code: 'PERMISSION_DENIED', nativeCode: '42501' })
  })

  it('keeps a statement that changed no rows whole for a streaming consumer, with no result field added', async () => {
    const r = wired('postgres', () => ({ ...rows([]), affectedRows: 3, hasRows: false }))
    const seen: unknown[] = []
    const [kept] = await r.adapter.executeSql(ns, 'UPDATE t SET a = 1', { ...EXEC, onResult: (x) => void seen.push(x) })
    expect(kept).not.toHaveProperty('result')
    expect(seen[0]).toEqual(kept)
  })
})
