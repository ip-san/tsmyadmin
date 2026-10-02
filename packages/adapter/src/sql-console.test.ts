import type { Dialect, Namespace, ProfileStage, StatementResult } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import type { Canceller, Conn, RawResult } from './driver.ts'
import { type ConsoleHost, ScriptRunner } from './sql-console.ts'
import { AdapterError, type ExecuteOptions } from './types.ts'

/**
 * ScriptRunner with no database behind it. The connection and the host are scripted, and every call they receive
 * goes into one ordered log, so the contract of a run (what it does to the connection, in which order, and what it
 * promises the next borrower) is read straight off that log. The same contract is checked against real MySQL and
 * PostgreSQL in test/conformance.ts; this file is what runs on every change, with no server.
 */

const ns: Namespace = { database: 'shop' }
const EXEC: ExecuteOptions = { maxRows: 100, timeoutMs: 1000, stopOnError: true }
const COLS = [{ name: 'a', dataType: 'int' }]

const rows = (...values: number[]): RawResult => ({
  columns: COLS,
  rows: values.map((v) => [v]),
  affectedRows: 0,
  hasRows: true,
})
const affected = (n: number): RawResult => ({ columns: [], rows: [], affectedRows: n, hasRows: false })

type Respond = (sql: string) => RawResult | RawResult[] | Promise<RawResult | RawResult[]>

interface RigOptions {
  dialect?: Dialect
  /** Whether the dialect caps result sets for the session (MySQL), so the runner does not wrap reads. */
  capped?: boolean
  respond?: Respond
  stages?: ProfileStage[] | null
  /** The server's answer to "is a transaction still open?"; a function may throw. */
  inTransaction?: () => Promise<boolean>
  copyFrom?: (sql: string, data: string) => Promise<number>
  backendId?: () => Promise<string>
  /** The connection's session reset, which a test may hold on the wire. */
  reset?: () => Promise<void>
  wrapperOnlyErrors?: string[]
}

function rig(options: RigOptions = {}) {
  const log: string[] = []
  const queries: string[] = []
  const respond: Respond = options.respond ?? (() => affected(1))
  const conn: Conn = {
    query: async (text) => {
      log.push(`q:${text}`)
      queries.push(text)
      return respond(text)
    },
    release: () => log.push('release-conn'),
    id: {},
    reset: async () => {
      log.push('reset')
      await options.reset?.()
    },
    forget: () => log.push('forget-conn'),
    discard: () => log.push('discard'),
    ...(options.inTransaction ? { inTransaction: options.inTransaction } : {}),
    ...(options.copyFrom ? { copyFrom: options.copyFrom } : {}),
  }
  const canceller = {
    cancel: vi.fn(async (_backend: string) => undefined) as unknown as Canceller['cancel'] & ReturnType<typeof vi.fn>,
    close: vi.fn(async () => undefined) as unknown as Canceller['close'] & ReturnType<typeof vi.fn>,
  }
  const openCanceller = vi.fn(async (): Promise<Canceller> => canceller)
  const host: ConsoleHost = {
    dialect: options.dialect ?? 'mysql',
    withConn: async (_ns, fn) => {
      try {
        return await fn(conn)
      } finally {
        log.push('released')
      }
    },
    forgetSessionState: () => log.push('forget'),
    capResultRows: async () => {
      log.push('cap')
      return options.capped ?? true
    },
    startProfiling: async () => true,
    readProfile: async () => options.stages ?? null,
    backendId: options.backendId ?? (async () => '42'),
    openCanceller,
    wrapperOnlyErrors: () => new Set(options.wrapperOnlyErrors ?? []),
    toAdapterError: (err) => (err instanceof AdapterError ? err : new AdapterError('QUERY_FAILED', String(err))),
  }
  return { runner: new ScriptRunner(host), log, queries, canceller, openCanceller }
}

const kinds = (rs: StatementResult[]) => rs.map((r) => r.kind)

/** A promise a test settles by hand: a statement that is still on the wire until the test says otherwise. */
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined
  let reject: (e: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('running a script', () => {
  it('runs each statement in order and reports rows and affected counts', async () => {
    const r = rig({ respond: (sql) => (sql.startsWith('SELECT') ? rows(1, 2) : affected(3)) })
    const results = await r.runner.execute(ns, 'INSERT INTO t VALUES (1); SELECT a FROM t', EXEC)
    expect(kinds(results)).toEqual(['affected', 'rows'])
    expect(results[0]).toMatchObject({ kind: 'affected', affectedRows: 3, statement: 0 })
    expect(results[1]).toMatchObject({ kind: 'rows', statement: 1, result: { rows: [[1], [2]], truncated: false } })
    expect(r.queries.slice(0, 2)).toEqual(['INSERT INTO t VALUES (1)', 'SELECT a FROM t'])
  })

  it('returns nothing for an empty script', async () => {
    const r = rig()
    expect(await r.runner.execute(ns, '  -- only a comment\n', EXEC)).toEqual([])
  })

  it('takes the statements it is given instead of splitting the text again', async () => {
    const r = rig()
    await r.runner.execute(ns, 'ignored; text', { ...EXEC, statements: [{ sql: 'SELECT 1', line: 7 }] })
    expect(r.queries[0]).toBe('SELECT 1')
    expect(r.queries).not.toContain('ignored')
  })

  it('keeps only maxRows of a longer result and says it was cut', async () => {
    const r = rig({ respond: () => rows(1, 2, 3, 4) })
    const [result] = await r.runner.execute(ns, 'SELECT a FROM t', { ...EXEC, maxRows: 3 })
    expect(result).toMatchObject({ kind: 'rows', result: { rows: [[1], [2], [3]], truncated: true } })
  })

  it('hands each result to onResult as it is made, and keeps only a row-less copy in what it returns', async () => {
    const r = rig({ respond: () => rows(1, 2) })
    const seen: [number, number][] = []
    const results = await r.runner.execute(ns, 'SELECT a FROM t; SELECT a FROM t', {
      ...EXEC,
      onResult: (res, index) => {
        if (res.kind === 'rows') seen.push([index, res.result.rows.length])
      },
    })
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
    ])
    // Counts and order survive; the rows do not stay in memory for the length of a long script.
    expect(results.map((x) => (x.kind === 'rows' ? x.result.rows.length : -1))).toEqual([0, 0])
  })

  it('says what the server printed when a statement fails, and stops there when told to', async () => {
    const r = rig({
      respond: (sql) => {
        if (sql === 'BAD')
          throw new AdapterError('QUERY_FAILED', 'wrapped', 'syntax near BAD', { nativeCode: '1064', position: 5 })
        return affected(1)
      },
    })
    const results = await r.runner.execute(ns, 'SELECT 1; BAD; SELECT 2', EXEC)
    expect(kinds(results)).toEqual(['affected', 'error'])
    expect(results[1]).toMatchObject({
      kind: 'error',
      message: 'syntax near BAD',
      code: 'QUERY_FAILED',
      nativeCode: '1064',
      position: 5,
      statement: 1,
    })
    expect(r.queries).not.toContain('SELECT 2')
  })

  it('goes on after a failed statement when stopOnError is off', async () => {
    const r = rig({
      respond: (sql) => {
        if (sql === 'BAD') throw new AdapterError('QUERY_FAILED', 'nope')
        return affected(1)
      },
    })
    const results = await r.runner.execute(ns, 'SELECT 1; BAD; SELECT 2', { ...EXEC, stopOnError: false })
    expect(kinds(results)).toEqual(['affected', 'error', 'affected'])
  })

  it('turns an error the driver threw into the adapter error of the dialect', async () => {
    const r = rig({
      respond: () => {
        throw new Error('driver blew up')
      },
    })
    const [result] = await r.runner.execute(ns, 'SELECT 1', EXEC)
    expect(result).toMatchObject({ kind: 'error', code: 'QUERY_FAILED' })
  })

  it('refuses a psql meta-command, which no server understands', async () => {
    const r = rig({ dialect: 'postgres' })
    const [result] = await r.runner.execute(ns, '\\connect other', {
      ...EXEC,
      statements: [{ sql: '\\connect other', line: 1 }],
    })
    expect(result).toMatchObject({ kind: 'error', code: 'UNSUPPORTED' })
    expect(r.queries.filter((q) => q.includes('connect'))).toEqual([])
  })

  it('sends a COPY … FROM stdin block through the connection, with its data', async () => {
    const copyFrom = vi.fn(async () => 2)
    const r = rig({ dialect: 'postgres', copyFrom })
    const block = 'COPY t (a) FROM stdin;\n1\n2\n\\.'
    const [result] = await r.runner.execute(ns, block, { ...EXEC, statements: [{ sql: block, line: 1 }] })
    expect(copyFrom).toHaveBeenCalledWith('COPY t (a) FROM stdin', '1\n2\n')
    expect(result).toMatchObject({ kind: 'affected', affectedRows: 2 })
  })

  it('refuses COPY … FROM stdin where the connection cannot do it', async () => {
    const r = rig({ dialect: 'postgres' })
    const block = 'COPY t (a) FROM stdin;\n1\n\\.'
    const [result] = await r.runner.execute(ns, block, { ...EXEC, statements: [{ sql: block, line: 1 }] })
    expect(result).toMatchObject({ kind: 'error', code: 'UNSUPPORTED' })
  })

  it('attaches the stages the server timed when profiling is on, and survives a profile it cannot read', async () => {
    const stages = [{ state: 'starting', seconds: 0.001 }]
    const profiled = rig({ stages })
    const [a] = await profiled.runner.execute(ns, 'SELECT 1', { ...EXEC, profile: true })
    expect(a).toMatchObject({ profile: stages })
    const unreadable = rig({ stages: null })
    const [b] = await unreadable.runner.execute(ns, 'SELECT 1', { ...EXEC, profile: true })
    expect(b?.kind).toBe('affected')
    expect(b).not.toHaveProperty('profile')
  })
})

describe('capping the rows a read may return', () => {
  it('wraps a plain read as a subquery with one row more than asked, where the dialect cannot cap the session', async () => {
    const r = rig({ dialect: 'postgres', capped: false, respond: () => rows(1) })
    await r.runner.execute(ns, 'SELECT a FROM t', { ...EXEC, maxRows: 10 })
    expect(r.queries[0]).toContain('SELECT * FROM (\nSELECT a FROM t\n) AS _tsmyadmin LIMIT 11')
  })

  it('leaves what is not a plain read alone', async () => {
    const r = rig({ dialect: 'postgres', capped: false })
    await r.runner.execute(ns, 'DELETE FROM t WHERE a = 1', EXEC)
    expect(r.queries[0]).toBe('DELETE FROM t WHERE a = 1')
  })

  it('does not wrap when the session is already capped, unless the statement has a LIMIT of its own', async () => {
    const capped = rig({ capped: true })
    await capped.runner.execute(ns, 'SELECT a FROM t', EXEC)
    expect(capped.queries[0]).toBe('SELECT a FROM t')
    const own = rig({ capped: true })
    await own.runner.execute(ns, 'SELECT a FROM t LIMIT 5', EXEC)
    expect(own.queries[0]).toContain('AS _tsmyadmin LIMIT 101')
  })

  it('runs a statement again as written when only the wrapper made it fail, and not otherwise', async () => {
    const wrapped = rig({
      dialect: 'postgres',
      capped: false,
      wrapperOnlyErrors: ['42701'],
      respond: (sql) => {
        if (sql.includes('_tsmyadmin'))
          throw new AdapterError('QUERY_FAILED', 'duplicate column', undefined, { nativeCode: '42701' })
        return rows(1)
      },
    })
    const [ok] = await wrapped.runner.execute(ns, 'SELECT 1 AS a, 2 AS a', EXEC)
    expect(ok?.kind).toBe('rows')
    expect(wrapped.queries.slice(0, 2)).toEqual([expect.stringContaining('_tsmyadmin'), 'SELECT 1 AS a, 2 AS a'])

    const other = rig({
      dialect: 'postgres',
      capped: false,
      respond: () => {
        throw new AdapterError('QUERY_FAILED', 'syntax error', undefined, { nativeCode: '42601' })
      },
    })
    const [failed] = await other.runner.execute(ns, 'SELECT FROM', EXEC)
    expect(failed?.kind).toBe('error')
    expect(other.queries.filter((q) => !q.startsWith('ROLLBACK'))).toHaveLength(1)
  })

  it('moves an error position back by the text the wrapper put in front of the statement', async () => {
    const r = rig({
      dialect: 'postgres',
      capped: false,
      respond: () => {
        // The server counts from the start of the wrapped text: 'SELECT * FROM (\n' is 16 characters long.
        throw new AdapterError('QUERY_FAILED', 'syntax error', undefined, { nativeCode: '42601', position: 16 + 8 })
      },
    })
    const [result] = await r.runner.execute(ns, 'SELECT a,, b FROM t', EXEC)
    expect(result).toMatchObject({ kind: 'error', position: 8 })
  })
})

describe('what a run leaves behind on its connection', () => {
  it('forgets the session cache first and, at the end, rolls back and resets before the connection goes back', async () => {
    const r = rig()
    await r.runner.execute(ns, 'SELECT 1', EXEC)
    expect(r.log).toEqual(['forget', 'cap', 'q:SELECT 1', 'q:ROLLBACK', 'reset', 'released'])
  })

  it('does the same after a statement failed', async () => {
    const r = rig({
      respond: () => {
        throw new AdapterError('QUERY_FAILED', 'nope')
      },
    })
    await r.runner.execute(ns, 'SELECT 1', EXEC)
    expect(r.log.slice(-3)).toEqual(['q:ROLLBACK', 'reset', 'released'])
  })

  it('tells the caller whether the server still holds a transaction, before it is rolled back', async () => {
    const answers: boolean[] = []
    const open = rig({ inTransaction: async () => true })
    await open.runner.execute(ns, 'BEGIN', { ...EXEC, onTransactionOpen: (o) => answers.push(o) })
    const closed = rig({ inTransaction: async () => false })
    await closed.runner.execute(ns, 'SELECT 1', { ...EXEC, onTransactionOpen: (o) => answers.push(o) })
    expect(answers).toEqual([true, false])
    // The question comes before the ROLLBACK that would make the answer "no".
    expect(open.log.indexOf('q:ROLLBACK')).toBeGreaterThan(-1)
  })

  it('says "nothing open" rather than something wrong when the probe itself fails', async () => {
    const answers: boolean[] = []
    const r = rig({
      inTransaction: async () => {
        throw new Error('probe failed')
      },
    })
    await r.runner.execute(ns, 'SELECT 1', { ...EXEC, onTransactionOpen: (o) => answers.push(o) })
    expect(answers).toEqual([false])
  })

  it('still rolls back and resets when the caller of onResult throws, and passes that error on', async () => {
    const r = rig()
    await expect(
      r.runner.execute(ns, 'SELECT 1', {
        ...EXEC,
        onResult: () => {
          throw new Error('the consumer is gone')
        },
      })
    ).rejects.toThrow('the consumer is gone')
    expect(r.log.slice(-3)).toEqual(['q:ROLLBACK', 'reset', 'released'])
  })

  it('still rolls back and resets when onTransactionOpen throws, so the connection is not handed on dirty', async () => {
    const r = rig({ inTransaction: async () => true })
    await expect(
      r.runner.execute(ns, 'BEGIN', {
        ...EXEC,
        onTransactionOpen: () => {
          throw new Error('callback failed')
        },
      })
    ).rejects.toThrow('callback failed')
    expect(r.log.slice(-3)).toEqual(['q:ROLLBACK', 'reset', 'released'])
  })
})

describe('cancelling', () => {
  /** A script whose first statement stays on the wire until `kill` ends it, as the server does for KILL QUERY. */
  function sleeping(options: { killFails: boolean }) {
    const slow = deferred<RawResult>()
    const r = rig({ respond: (sql) => (sql === 'SLEEP' ? slow.promise : affected(1)) })
    ;(r.canceller.cancel as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (options.killFails) slow.reject(new AdapterError('QUERY_FAILED', 'interrupted'))
      else slow.resolve(rows(1))
    })
    return r
  }

  it('says nothing was running for an id it does not know, and for a run that has already ended', async () => {
    const r = rig()
    expect(await r.runner.cancel('nope')).toBe(false)
    await r.runner.execute(ns, 'SELECT 1', { ...EXEC, queryId: 'done' })
    expect(await r.runner.cancel('done')).toBe(false)
    expect(r.openCanceller).not.toHaveBeenCalled()
  })

  it('interrupts the statement on the wire, stops the script even when errors are not meant to, and drops the connection', async () => {
    const r = sleeping({ killFails: true })
    const run = r.runner.execute(ns, 'SLEEP; SELECT 2', { ...EXEC, stopOnError: false, queryId: 'q' })
    await vi.waitFor(() => expect(r.queries).toContain('SLEEP'))
    expect(await r.runner.cancel('q')).toBe(true)
    const results = await run
    expect(kinds(results)).toEqual(['error'])
    expect(r.queries).not.toContain('SELECT 2')
    expect(r.canceller.cancel).toHaveBeenCalledWith('42')
    expect(r.canceller.close).toHaveBeenCalled()
    // A cancel signal may still be in transit: the connection is closed, not reset and reused.
    expect(r.log).toContain('discard')
    expect(r.log).not.toContain('reset')
  })

  it('drops the connection when the cancel arrives while the finished run is cleaning it up', async () => {
    // The run decided to keep its connection (nothing had been cancelled), then spent a round trip on the ROLLBACK
    // and the session reset. A cancel that lands in that gap still sends its signal, to a connection that goes back
    // to the pool and may already be serving the next request when the signal arrives.
    const resetting = deferred<void>()
    const r = rig({ reset: () => resetting.promise })
    const run = r.runner.execute(ns, 'SELECT 1', { ...EXEC, queryId: 'q' })
    await vi.waitFor(() => expect(r.log).toContain('reset'))
    const cancelled = r.runner.cancel('q')
    await vi.waitFor(() => expect(r.canceller.cancel).toHaveBeenCalledWith('42'))
    resetting.resolve()
    await run
    await cancelled
    expect(r.log).toContain('discard')
  })

  it('counts a statement the server stopped without failing it (MySQL: KILL QUERY on SLEEP returns a row)', async () => {
    const r = sleeping({ killFails: false })
    const run = r.runner.execute(ns, 'SLEEP; SELECT 2', { ...EXEC, queryId: 'q' })
    await vi.waitFor(() => expect(r.queries).toContain('SLEEP'))
    expect(await r.runner.cancel('q')).toBe(true)
    const results = await run
    expect(kinds(results)).toEqual(['rows'])
    expect(r.queries).not.toContain('SELECT 2')
  })

  it('waits for the connection to say which server-side id to signal, instead of missing the run', async () => {
    const id = deferred<string>()
    const r = rig({
      backendId: () => id.promise,
      respond: (sql) => (sql === 'SLEEP' ? new Promise<RawResult>(() => undefined) : affected(1)),
    })
    void r.runner.execute(ns, 'SLEEP', { ...EXEC, queryId: 'q' })
    void r.runner.cancel('q')
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The run has no server-side id yet, so there is nothing to address a signal to.
    expect(r.canceller.cancel).not.toHaveBeenCalled()
    id.resolve('77')
    await vi.waitFor(() => expect(r.canceller.cancel).toHaveBeenCalledWith('77'))
  })

  it('answers false when the run ended before it ever had a server-side id', async () => {
    const r = rig({
      backendId: async () => {
        throw new Error('no connection')
      },
    })
    const run = r.runner.execute(ns, 'SELECT 1', { ...EXEC, queryId: 'q' })
    const cancelled = r.runner.cancel('q')
    await expect(run).rejects.toThrow('no connection')
    expect(await cancelled).toBe(false)
  })

  it('opens one connection for a burst of cancels, and every one of them gets the answer', async () => {
    const r = sleeping({ killFails: true })
    const run = r.runner.execute(ns, 'SLEEP', { ...EXEC, queryId: 'q' })
    await vi.waitFor(() => expect(r.queries).toContain('SLEEP'))
    const answers = await Promise.all(Array.from({ length: 10 }, () => r.runner.cancel('q')))
    await run
    expect(answers).toEqual(Array(10).fill(true))
    expect(r.openCanceller).toHaveBeenCalledTimes(1)
  })

  it('keeps sending the signal while the statement is still on the wire, since one that lands on an idle connection does nothing', async () => {
    const slow = deferred<RawResult>()
    const r = rig({ respond: (sql) => (sql === 'SLEEP' ? slow.promise : affected(1)) })
    let sent = 0
    ;(r.canceller.cancel as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sent++
      // Only the third signal reaches a statement that is really running.
      if (sent === 3) slow.reject(new AdapterError('QUERY_FAILED', 'interrupted'))
    })
    const run = r.runner.execute(ns, 'SLEEP', { ...EXEC, queryId: 'q' })
    await vi.waitFor(() => expect(r.queries).toContain('SLEEP'))
    expect(await r.runner.cancel('q')).toBe(true)
    await run
    expect(sent).toBe(3)
  })

  it('does not let a run that has the same id as another take the other one out of the registry when it ends', async () => {
    const first = deferred<RawResult>()
    const second = deferred<RawResult>()
    const r = rig({
      respond: (sql) => (sql === 'FIRST' ? first.promise : sql === 'SECOND' ? second.promise : affected(1)),
    })
    ;(r.canceller.cancel as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      second.reject(new AdapterError('QUERY_FAILED', 'interrupted'))
    })
    const a = r.runner.execute(ns, 'FIRST', { ...EXEC, queryId: 'same' })
    await vi.waitFor(() => expect(r.queries).toContain('FIRST'))
    const b = r.runner.execute(ns, 'SECOND', { ...EXEC, queryId: 'same' })
    await vi.waitFor(() => expect(r.queries).toContain('SECOND'))
    // The first run ends; the second, with the same id, is still going and must still be cancellable.
    first.resolve(affected(1))
    await a
    expect(await r.runner.cancel('same')).toBe(true)
    await b
  })
})
