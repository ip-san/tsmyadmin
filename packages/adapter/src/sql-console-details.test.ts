import type { Dialect, Namespace, ProfileStage, StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import type { Canceller, Conn, RawResult } from './driver.ts'
import { WRAP_PREFIX } from './sql/read-wrap.ts'
import { type ConsoleHost, ScriptRunner } from './sql-console.ts'
import { until } from './test/scripted-conn.ts'
import { AdapterError, type ExecuteOptions } from './types.ts'

/**
 * What sql-console.test.ts leaves to chance: the exact words and fields of a result, the notices and profile that ride
 * on it, how an error position moves back, and the cancel's own branches (a bad backend id, a refused signal, the
 * signal sent again while the statement is still on the wire). The host and the connection are scripted.
 */

const ns: Namespace = { database: 'shop' }
const EXEC: ExecuteOptions = { maxRows: 10, timeoutMs: 1000, stopOnError: true }
const COLS = [{ name: 'a', dataType: 'int' }]
const rowsOf = (n: number, extra: Partial<RawResult> = {}): RawResult => ({
  columns: COLS,
  rows: Array.from({ length: n }, (_, i) => [i]),
  affectedRows: 0,
  hasRows: true,
  ...extra,
})
const affected = (n: number, extra: Partial<RawResult> = {}): RawResult => ({
  columns: [],
  rows: [],
  affectedRows: n,
  hasRows: false,
  ...extra,
})

interface Rig {
  dialect?: Dialect
  capped?: boolean
  respond?: (sql: string) => RawResult | RawResult[] | Promise<RawResult | RawResult[]>
  stages?: () => Promise<ProfileStage[] | null>
  backendId?: () => Promise<string>
  copyFrom?: (sql: string, data: string) => Promise<number>
  wrapperOnlyErrors?: string[]
  capResultRows?: () => Promise<boolean>
}
function rig(o: Rig = {}) {
  const asked: string[] = []
  const conn: Conn = {
    query: async (text) => {
      asked.push(text)
      return (o.respond ?? (() => affected(1)))(text)
    },
    release: () => undefined,
    id: {},
    reset: async () => undefined,
    forget: () => undefined,
    discard: vi.fn(),
    ...(o.copyFrom ? { copyFrom: o.copyFrom } : {}),
  }
  const canceller = { cancel: vi.fn(async (_b: string) => undefined), close: vi.fn(async () => undefined) }
  const openCanceller = vi.fn(async (): Promise<Canceller> => canceller as unknown as Canceller)
  const capResultRows = vi.fn(o.capResultRows ?? (async () => o.capped ?? true))
  const startProfiling = vi.fn(async () => true)
  const host: ConsoleHost = {
    dialect: o.dialect ?? 'mysql',
    withConn: async (_ns, fn) => await fn(conn),
    forgetSessionState: () => undefined,
    capResultRows,
    startProfiling,
    readProfile: o.stages ?? (async () => null),
    backendId: o.backendId ?? (async () => '42'),
    openCanceller,
    wrapperOnlyErrors: () => new Set(o.wrapperOnlyErrors ?? []),
    toAdapterError: (err) => (err instanceof AdapterError ? err : new AdapterError('QUERY_FAILED', String(err))),
  }
  return {
    runner: new ScriptRunner(host),
    asked: {
      get list() {
        return asked.filter((q) => q !== 'ROLLBACK')
      },
    },
    canceller,
    openCanceller,
    capResultRows,
    startProfiling,
    conn,
  }
}
const run = (r: ReturnType<typeof rig>, sql: string, opts: Partial<ExecuteOptions> = {}) =>
  r.runner.execute(ns, sql, { ...EXEC, ...opts })
const deferred = <T>() => {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
const one = async (
  r: ReturnType<typeof rig>,
  sql: string,
  opts: Partial<ExecuteOptions> = {}
): Promise<StatementResult> => {
  const [result] = await run(r, sql, opts)
  if (!result) throw new Error('no result')
  return result
}

describe('a result: its words and fields', () => {
  it('says which meta-command a psql line was, by its first word, as the message', async () => {
    const r = rig({ dialect: 'postgres' })
    expect(await one(r, '', { statements: [{ sql: '\\connect other_db', line: 3 }] })).toMatchObject({
      kind: 'error',
      code: 'UNSUPPORTED',
      message: 'psql meta-command is not supported: \\connect',
      line: 3,
      statement: 0,
    })
    expect(await one(r, '', { statements: [{ sql: '\\d\n', line: 1 }] })).toMatchObject({
      message: 'psql meta-command is not supported: \\d',
    })
  })

  it("hands a COPY block's statement line and data to the connection, and reports the rows it copied", async () => {
    const calls: [string, string][] = []
    const r = rig({
      dialect: 'postgres',
      copyFrom: async (sql, data) => {
        calls.push([sql, data])
        return 2
      },
    })
    const result = await one(r, 'COPY t (a, b) FROM STDIN;\n1\t2\n3\t4\n\\.')
    expect(calls).toEqual([['COPY t (a, b) FROM STDIN', '1\t2\n3\t4\n']])
    expect(result).toMatchObject({ kind: 'affected', affectedRows: 2 })
    expect(r.asked.list).toHaveLength(0)
  })

  it('refuses a COPY block where the connection cannot do it, saying so', async () => {
    const r = rig({ dialect: 'postgres' })
    expect(await one(r, 'COPY t FROM STDIN;\n1\n\\.')).toMatchObject({
      kind: 'error',
      code: 'UNSUPPORTED',
      message: 'COPY FROM stdin is not supported',
    })
  })

  it('does not take a COPY block for one on MySQL', async () => {
    const r = rig({ dialect: 'mysql', copyFrom: async () => 9 })
    await run(r, 'COPY t FROM STDIN')
    expect(r.asked.list).toEqual(['COPY t FROM STDIN'])
  })

  it('carries the notices of a statement, rows or not, and none when there are none', async () => {
    const withNotices = rig({
      respond: (sql) =>
        sql.startsWith('SELECT') ? rowsOf(1, { notices: ['NOTICE: a'] }) : affected(1, { notices: ['WARNING: b'] }),
    })
    const [sel, upd] = await run(withNotices, 'SELECT 1; UPDATE t SET a = 1')
    expect(sel).toMatchObject({ notices: ['NOTICE: a'] })
    expect(upd).toMatchObject({ notices: ['WARNING: b'] })
    const empty = rig({
      respond: (sql) => (sql.startsWith('SELECT') ? rowsOf(1, { notices: [] }) : affected(1, { notices: [] })),
    })
    for (const result of await run(empty, 'SELECT 1; UPDATE t SET a = 1')) expect(result).not.toHaveProperty('notices')
  })

  it('carries the stages of a profile on the result of every statement, and nothing for an empty or unreadable one', async () => {
    const stages: ProfileStage[] = [{ state: 'starting', seconds: 0.1 }]
    const timed = rig({ stages: async () => stages })
    expect(await one(timed, 'SELECT 1', { profile: true })).toMatchObject({ profile: stages })
    expect(timed.startProfiling).toHaveBeenCalledTimes(1)
    const notAsked = rig({ stages: async () => stages })
    expect(await one(notAsked, 'SELECT 1')).not.toHaveProperty('profile')
    expect(notAsked.startProfiling).not.toHaveBeenCalled()
    expect(await one(rig({ stages: async () => [] }), 'SELECT 1', { profile: true })).not.toHaveProperty('profile')
    expect(
      await one(rig({ stages: async () => Promise.reject(new Error('no')) }), 'SELECT 1', { profile: true })
    ).not.toHaveProperty('profile')
  })

  it('applies the cap again after a statement that changed it, and not after any other', async () => {
    const r = rig()
    await run(r, 'SELECT 1; SET SESSION sql_select_limit = 5; SELECT 2')
    expect(r.capResultRows).toHaveBeenCalledTimes(2)
    const plain = rig()
    await run(plain, 'SELECT 1; SELECT 2')
    expect(plain.capResultRows).toHaveBeenCalledTimes(1)
    const uncapped = rig({ capped: false })
    await run(uncapped, 'SET SESSION sql_select_limit = 5')
    expect(uncapped.capResultRows).toHaveBeenCalledTimes(1)
  })

  it('cuts a longer result to maxRows and says so, but not one that fits exactly', async () => {
    expect(await one(rig({ respond: () => rowsOf(11) }), 'SELECT 1')).toMatchObject({ result: { truncated: true } })
    const exact = (await one(rig({ respond: () => rowsOf(10) }), 'SELECT 1')) as Extract<
      StatementResult,
      { kind: 'rows' }
    >
    expect(exact.result.truncated).toBe(false)
    expect(exact.result.rows).toHaveLength(10)
  })

  it('keeps the full result of a non-row statement for a streaming consumer, not a row-less copy', async () => {
    const seen: StatementResult[] = []
    const r = rig({ respond: () => affected(4) })
    const out = await run(r, 'UPDATE t SET a = 1', { onResult: (x) => void seen.push(x) })
    expect(out[0]).toMatchObject({ kind: 'affected', affectedRows: 4 })
    expect(seen[0]).toMatchObject({ kind: 'affected', affectedRows: 4 })
  })

  it('reports the native code and position of a failure only when the server gave them', async () => {
    const full = rig({
      respond: () =>
        Promise.reject(new AdapterError('QUERY_FAILED', 'm', 'the detail', { nativeCode: '42601', position: 7 })),
    })
    expect(await one(full, 'SELEC')).toMatchObject({
      kind: 'error',
      message: 'the detail',
      code: 'QUERY_FAILED',
      nativeCode: '42601',
      position: 7,
    })
    const bare = rig({ respond: () => Promise.reject(new AdapterError('QUERY_FAILED', 'm')) })
    const result = await one(bare, 'SELEC')
    expect(result).toMatchObject({ message: 'm' })
    expect(result).not.toHaveProperty('nativeCode')
    expect(result).not.toHaveProperty('position')
  })
})

describe('an error in a wrapped read', () => {
  const wrapped = (e: AdapterError, wrapperOnly: string[] = []) =>
    rig({ capped: false, wrapperOnlyErrors: wrapperOnly, respond: () => Promise.reject(e) })

  it("moves the position back by the wrapper's prefix, keeping the native code, only for a position inside the statement", async () => {
    const inside = new AdapterError('QUERY_FAILED', 'm', undefined, {
      nativeCode: '42601',
      position: WRAP_PREFIX.length + 5,
    })
    expect(await one(wrapped(inside), 'SELECT x FROM')).toMatchObject({ position: 5, nativeCode: '42601' })
    const noNative = new AdapterError('QUERY_FAILED', 'm', undefined, { position: WRAP_PREFIX.length + 2 })
    const shifted = await one(wrapped(noNative), 'SELECT x FROM')
    expect(shifted).toMatchObject({ position: 2 })
    expect(shifted).not.toHaveProperty('nativeCode')
  })

  it('leaves a position at or before the prefix as it is, and an error without one', async () => {
    const atPrefix = new AdapterError('QUERY_FAILED', 'm', undefined, { position: WRAP_PREFIX.length })
    expect(await one(wrapped(atPrefix), 'SELECT x FROM')).toMatchObject({ position: WRAP_PREFIX.length })
    const before = new AdapterError('QUERY_FAILED', 'm', undefined, { position: 3 })
    expect(await one(wrapped(before), 'SELECT x FROM')).toMatchObject({ position: 3 })
    expect(await one(wrapped(new AdapterError('QUERY_FAILED', 'm')), 'SELECT x FROM')).not.toHaveProperty('position')
  })

  it('does not run a statement again for an error that is not one the wrapper causes, or that has no native code', async () => {
    for (const e of [
      new AdapterError('QUERY_FAILED', 'm', undefined, { nativeCode: 'OTHER' }),
      new AdapterError('QUERY_FAILED', 'm'),
    ]) {
      const r = wrapped(e, ['ONLY_WRAPPER'])
      await run(r, 'SELECT x FROM t')
      expect(r.asked.list).toHaveLength(1)
    }
    const again = rig({
      capped: false,
      wrapperOnlyErrors: ['ONLY_WRAPPER'],
      respond: (sql) =>
        sql.startsWith('SELECT * FROM (')
          ? Promise.reject(new AdapterError('QUERY_FAILED', 'm', undefined, { nativeCode: 'ONLY_WRAPPER' }))
          : rowsOf(1),
    })
    expect(await one(again, 'SELECT x FROM t')).toMatchObject({ kind: 'rows' })
    expect(again.asked.list).toEqual([expect.stringContaining('_tsmyadmin'), 'SELECT x FROM t'])
  })
})

describe('cancelling: its own branches', () => {
  /** Waits until the canceller has been asked at least `n` times (the retry runs on a timer that slips under load). */
  const signalled = (r: ReturnType<typeof rig>, n: number) => until(() => r.canceller.cancel.mock.calls.length >= n)
  /** A run whose one statement stays on the wire until `finish()`. */
  const hung = (backend = '42') => {
    const wire = deferred<RawResult>()
    const r = rig({ backendId: async () => backend, respond: () => wire.promise })
    const finished = run(r, 'SELECT SLEEP(10)', { queryId: 'q' })
    return { r, wire, finished }
  }
  /** Waits until the run's first statement has been sent, so a cancel finds it on the wire. */
  const onWire = (r: ReturnType<typeof rig>, sql = 'SELECT SLEEP(10)') => until(() => r.asked.list.includes(sql))

  it('says nothing was cancelled, and signals nothing, when the server-side id is not all digits', async () => {
    for (const backend of ['', 'abc', '12x', 'x12', '1 2']) {
      const { r, wire, finished } = hung(backend)
      await onWire(r)
      expect(await r.runner.cancel('q', 50), backend).toBe(false)
      expect(r.openCanceller).not.toHaveBeenCalled()
      wire.resolve(rowsOf(1))
      await finished
    }
  })

  it('gives up waiting for the id after the time it is given, and says nothing was cancelled', async () => {
    const never = deferred<string>()
    const wire = deferred<RawResult>()
    const r = rig({ backendId: () => never.promise, respond: () => wire.promise })
    const finished = run(r, 'SELECT 1', { queryId: 'q' })
    const started = Date.now()
    expect(await r.runner.cancel('q', 30)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
    never.resolve('')
    wire.resolve(rowsOf(1))
    await finished
  })

  it('sends the signal to the backend, again while the statement is still on the wire, and closes its connection', async () => {
    const { r, wire, finished } = hung('77')
    await onWire(r)
    const answer = r.runner.cancel('q')
    await signalled(r, 3)
    wire.resolve(rowsOf(1))
    expect(await answer).toBe(true)
    await finished
    expect(r.canceller.cancel.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(r.canceller.cancel.mock.calls.every(([b]) => b === '77')).toBe(true)
    expect(r.canceller.close).toHaveBeenCalledTimes(1)
  })

  it('does not fail the request when a resent signal is refused', async () => {
    const { r, wire, finished } = hung()
    await onWire(r)
    let calls = 0
    r.canceller.cancel.mockImplementation(async () => {
      if (++calls > 1) throw new Error('no such thread')
    })
    const answer = r.runner.cancel('q')
    await signalled(r, 2)
    wire.resolve(rowsOf(1))
    expect(await answer).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(2)
    await finished
  })

  it('fails the request when the first signal is refused while the run is still going, and lets the next cancel try again', async () => {
    const { r, wire, finished } = hung()
    await onWire(r)
    r.canceller.cancel.mockRejectedValueOnce(new Error('refused'))
    await expect(r.runner.cancel('q')).rejects.toThrow('refused')
    expect(r.canceller.close).toHaveBeenCalledTimes(1)
    const second = r.runner.cancel('q')
    await signalled(r, 2)
    wire.resolve(rowsOf(1))
    expect(await second).toBe(true)
    expect(r.openCanceller).toHaveBeenCalledTimes(2)
    await finished
  })

  it('answers whether the flag stopped a run that ended while the signal was being opened', async () => {
    const wire = deferred<RawResult>()
    const opening = deferred<void>()
    const r = rig({ respond: () => wire.promise })
    r.openCanceller.mockImplementation(async () => {
      await opening.promise
      return r.canceller as unknown as Canceller
    })
    const finished = run(r, 'SELECT 1; SELECT 2', { queryId: 'q', stopOnError: false })
    await onWire(r, 'SELECT 1')
    const answer = r.runner.cancel('q')
    await until(() => r.openCanceller.mock.calls.length > 0)
    wire.resolve(rowsOf(1))
    await finished
    opening.resolve()
    expect(await answer).toBe(true)
    expect(r.canceller.cancel).not.toHaveBeenCalled()
    expect(r.canceller.close).toHaveBeenCalledTimes(1)
  })
})
