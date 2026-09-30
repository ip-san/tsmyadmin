/**
 * Running a script for the SQL console and cancelling it. One `ScriptRunner` belongs to one adapter; what it needs
 * from the adapter (a connection, the dialect's session hooks, a way to cancel) comes through `ConsoleHost`, so
 * this file knows nothing of mysql2 or pg and is read on its own.
 *
 * A run is registered under its `queryId` before it has a connection, so a cancel that arrives early waits for the
 * backend id instead of missing. The script loop checks a flag between statements; the cancel signal (KILL QUERY /
 * pg_cancel_backend) stops the statement that is on the wire.
 */
import type { Dialect, Namespace, ProfileStage, StatementResult } from '@tsmyadmin/shared'
import type { Canceller, Conn, RawResult } from './driver.ts'
import { DISPLAY } from './sql/cells.ts'
import { stripLiterals, WRAP_PREFIX, wrapReadOnly } from './sql/read-wrap.ts'
import { splitStatements, stripLeadingComments } from './sql/split.ts'
import { AdapterError, type ExecuteOptions } from './types.ts'

/** psql meta-command line (`\connect`, `\copy`, `\.`) that reached the server-side splitter. */
const META_COMMAND = /^\\/
/**
 * A COPY block as the splitter assembles it: the statement line, then the data lines (each with its newline, so
 * an empty table and one empty-string row stay distinct), then `\.`.
 */
const COPY_BLOCK = /^(COPY\b[\s\S]*?\bFROM\s+STDIN\b[^\n]*?)[ \t]*;?[ \t]*\r?\n([\s\S]*?)\\\.$/i

interface RunningEntry {
  ns: Namespace
  backend: Promise<string>
  cancelled: boolean
  /** True once the flag actually stopped the script (a statement was interrupted or the loop broke before one). */
  interrupted: boolean
  /**
   * True once a cancel signal was delivered while a statement was in flight. MySQL's KILL QUERY does not
   * always make the statement fail — `SELECT SLEEP(20)` just returns early with a row — so `interrupted`
   * alone would report "not cancelled" for a query the server really did stop.
   */
  signalled: boolean
  /** Resolves when the run has ended, whatever the outcome. */
  settled: Promise<void>
  /** True while a statement is on the wire; a cancel that lands on an idle connection is a no-op and is retried. */
  inFlight: boolean
  /** The cancel in progress, shared by concurrent cancel requests for the same run. */
  cancelling: Promise<boolean> | null
}

const CANCEL_RETRY_MS = 50
const CANCEL_RETRIES = 40
/** How long a cancel waits for the script loop to report what the signal did before answering "stopping". */
const CANCEL_SETTLE_MS = 10_000

/** A statement's own LIMIT takes precedence over MySQL's sql_select_limit. */
const HAS_LIMIT = /\bLIMIT\b/i
const TOUCHES_CAP = /sql_select_limit/i

/** What a run needs from the adapter that owns it. */
export interface ConsoleHost {
  readonly dialect: Dialect
  withConn<T>(ns: Namespace, fn: (conn: Conn) => Promise<T>, timeoutMs?: number): Promise<T>
  /** Drops what the adapter cached about the connection's session (user SQL may have changed it). */
  forgetSessionState(conn: Conn): void
  /** Caps result sets for the whole session where the dialect can; false where the runner must wrap each read. */
  capResultRows(conn: Conn, maxRows: number): Promise<boolean>
  startProfiling(conn: Conn): Promise<boolean>
  readProfile(conn: Conn): Promise<ProfileStage[] | null>
  /** The server-side id a cancel signal is addressed to. */
  backendId(conn: Conn): Promise<string>
  openCanceller(ns: Namespace): Promise<Canceller>
  /** Errors only the derived-table wrapper causes: the statement is run again as written. */
  wrapperOnlyErrors(): ReadonlySet<string>
  toAdapterError(err: unknown): AdapterError
}

export class ScriptRunner {
  constructor(private readonly host: ConsoleHost) {}

  /**
   * Running executeSql calls by queryId. The entry is registered synchronously when executeSql starts so a
   * cancel that arrives while the connection is still being acquired waits for the backend id instead of missing.
   */
  private readonly running = new Map<string, RunningEntry>()

  async execute(ns: Namespace, script: string, opts: ExecuteOptions): Promise<StatementResult[]> {
    const statements = opts.statements ?? splitStatements(script, this.host.dialect)
    const results: StatementResult[] = []
    const emit = async (r: StatementResult) => {
      // When results are streamed to a consumer, keep only a row-less copy here (counts stay correct) so a long
      // script does not retain every result set until it ends.
      results.push(opts.onResult && r.kind === 'rows' ? { ...r, result: { ...r.result, rows: [] } } : r)
      await opts.onResult?.(r, results.length - 1)
    }
    let resolveBackend: (id: string) => void = () => undefined
    let resolveSettled: () => void = () => undefined
    const entry: RunningEntry = {
      ns,
      backend: new Promise<string>((resolve) => {
        resolveBackend = resolve
      }),
      cancelled: false,
      interrupted: false,
      signalled: false,
      inFlight: false,
      cancelling: null,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve
      }),
    }
    if (opts.queryId) this.running.set(opts.queryId, entry)
    try {
      await this.host.withConn(
        ns,
        async (conn) => {
          try {
            // User SQL may SET the session timeout / namespace itself; never trust the cached values afterwards.
            this.host.forgetSessionState(conn)
            let capped = await this.host.capResultRows(conn, opts.maxRows)
            const profiling = opts.profile ? await this.host.startProfiling(conn) : false
            // Published only now: a cancel must interrupt the user's first statement, not the session setup.
            if (opts.queryId) resolveBackend(await this.host.backendId(conn))
            for (const [statement, st] of statements.entries()) {
              if (entry.cancelled) {
                entry.interrupted = true
                break
              }
              const started = performance.now()
              try {
                entry.inFlight = true
                let list: RawResult[]
                const code = stripLiterals(st.sql, this.host.dialect)
                const copy =
                  this.host.dialect === 'postgres' ? COPY_BLOCK.exec(stripLeadingComments(st.sql, 'postgres')) : null
                try {
                  if (META_COMMAND.test(st.sql)) {
                    throw new AdapterError(
                      'UNSUPPORTED',
                      `psql meta-command is not supported: ${st.sql.split(/\s/)[0]}`,
                      `psql meta-command is not supported: ${st.sql.split(/\s/)[0]}`
                    )
                  }
                  if (copy) {
                    if (!conn.copyFrom) throw new AdapterError('UNSUPPORTED', 'COPY FROM stdin is not supported')
                    const affectedRows = await conn.copyFrom(copy[1] ?? '', copy[2] ?? '')
                    list = [{ hasRows: false, affectedRows, columns: [], rows: [] }]
                  } else {
                    list = await this.runStatement(
                      conn,
                      st.sql,
                      capped && !HAS_LIMIT.test(code) ? null : opts.maxRows,
                      () => entry.cancelled
                    )
                  }
                } finally {
                  entry.inFlight = false
                }
                // Read before anything else runs: the profile is of the most recent statement.
                const stages = profiling ? await this.host.readProfile(conn).catch(() => null) : null
                const profile = stages && stages.length > 0 ? { profile: stages } : {}
                // A script that changed the cap itself (SET SESSION sql_select_limit …) gets it re-applied.
                if (capped && TOUCHES_CAP.test(code)) capped = await this.host.capResultRows(conn, opts.maxRows)
                const durationMs = Math.round(performance.now() - started)
                for (const r of list) {
                  if (r.hasRows) {
                    const truncated = r.rows.length > opts.maxRows
                    await emit({
                      kind: 'rows',
                      sql: st.sql,
                      line: st.line,
                      statement,
                      durationMs,
                      ...(r.notices && r.notices.length > 0 ? { notices: r.notices } : {}),
                      ...profile,
                      result: {
                        columns: r.columns,
                        rows: truncated ? r.rows.slice(0, opts.maxRows) : r.rows,
                        truncated,
                      },
                    })
                  } else {
                    await emit({
                      kind: 'affected',
                      sql: st.sql,
                      line: st.line,
                      statement,
                      durationMs,
                      affectedRows: r.affectedRows,
                      ...(r.notices && r.notices.length > 0 ? { notices: r.notices } : {}),
                      ...profile,
                    })
                  }
                }
              } catch (err) {
                const e = err instanceof AdapterError ? err : this.host.toAdapterError(err)
                await emit({
                  kind: 'error',
                  sql: st.sql,
                  line: st.line,
                  statement,
                  message: e.detail ?? e.message,
                  code: e.code,
                  ...(e.nativeCode ? { nativeCode: e.nativeCode } : {}),
                  ...(e.position ? { position: e.position } : {}),
                })
                if (entry.cancelled) entry.interrupted = true
                if (opts.stopOnError) break
              }
            }
          } finally {
            // Each execution is autocommitted: a transaction the script left open (or aborted) must not leak
            // into the next borrower of this pooled connection — nor may any session state the script set
            // (autocommit, sql_mode, SET ROLE, user variables, ...), hence the full session reset afterwards.
            // In a finally so an onResult/backendId failure cannot return a dirty connection to the pool.
            // After a cancel the connection is closed rather than reused: a KILL QUERY / pg_cancel_backend
            // signal still in transit would otherwise interrupt whatever the next borrower runs on it.
            // Asked before the ROLLBACK, including after a cancel: KILL QUERY / pg_cancel_backend end the
            // statement, not the transaction, so an interrupted script leaves work behind just like any other.
            if (opts.onTransactionOpen) {
              // A probe that cannot run says nothing rather than something wrong.
              const open = await conn.inTransaction?.().catch(() => false)
              opts.onTransactionOpen(open === true)
            }
            if (entry.cancelled) conn.discard()
            else {
              await conn.query('ROLLBACK').catch(() => undefined)
              await conn.reset()
            }
          }
        },
        opts.timeoutMs
      )
    } finally {
      if (opts.queryId) {
        this.running.delete(opts.queryId)
        resolveBackend('') // release any waiting cancelQuery
      }
      resolveSettled()
    }
    return results
  }

  /**
   * Runs one user statement. Unless the dialect caps result sets session-wide (capResultRows), a plain read
   * (SELECT / WITH / VALUES / TABLE without INTO or row locks) is wrapped as
   * `SELECT * FROM (...) AS _tsmyadmin LIMIT maxRows + 1` so a `SELECT * FROM huge_table` never materialises
   * the whole table in this process; the extra row is how the caller detects truncation. Error positions are
   * shifted back by the wrapper prefix.
   */
  private async runStatement(
    conn: Conn,
    sql: string,
    wrapMaxRows: number | null,
    cancelled: () => boolean
  ): Promise<RawResult[]> {
    const asList = (raw: RawResult | RawResult[]) => (Array.isArray(raw) ? raw : [raw])
    const wrapped = wrapMaxRows === null ? null : wrapReadOnly(sql, wrapMaxRows + 1, this.host.dialect)
    if (!wrapped) return asList(await conn.query(sql, undefined, DISPLAY))
    try {
      return asList(await conn.query(wrapped, undefined, DISPLAY))
    } catch (err) {
      const e = err instanceof AdapterError ? err : this.host.toAdapterError(err)
      // Statements the wrapper itself breaks (MySQL: duplicate column names, top-level-only modifiers) are
      // re-run as written — never after an interruption, which would restart the cancelled statement.
      if (e.nativeCode !== undefined && this.host.wrapperOnlyErrors().has(e.nativeCode) && !cancelled()) {
        return asList(await conn.query(sql, undefined, DISPLAY))
      }
      if (e.position !== undefined && e.position > WRAP_PREFIX.length) {
        throw new AdapterError(e.code, e.message, e.detail, {
          ...(e.nativeCode ? { nativeCode: e.nativeCode } : {}),
          position: e.position - WRAP_PREFIX.length,
        })
      }
      throw e
    }
  }

  /** Cancels a registered run. Waits up to `waitMs` for the run to reach the server (pool acquisition). */
  async cancel(queryId: string, waitMs = 10_000): Promise<boolean> {
    const entry = this.running.get(queryId)
    if (!entry) return false
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    const backend = await Promise.race([
      entry.backend,
      new Promise<string>((resolve) => {
        waitTimer = setTimeout(() => resolve(''), waitMs)
      }),
    ]).finally(() => clearTimeout(waitTimer))
    if (!/^\d+$/.test(backend)) return false
    // Also stop the script loop: with stopOnError=false the run would otherwise continue with the next statement.
    entry.cancelled = true
    // Concurrent cancel requests for one run share a single cancel (and its one dedicated connection): a
    // burst of clicks must not open a burst of connections against the server.
    entry.cancelling ??= this.sendCancel(queryId, entry, backend).catch((err: unknown) => {
      // A cancel that could not even open its connection must not poison every later click for this run.
      entry.cancelling = null
      throw err
    })
    return entry.cancelling
  }

  private async sendCancel(queryId: string, entry: RunningEntry, backend: string): Promise<boolean> {
    // The run may have finished while waiting: its connection is back in the pool, possibly serving someone else.
    // The flag set above already stops the script at the next statement boundary, so a run that was still
    // registered a moment ago was cancelled even when no signal needs sending.
    // A run that ended meanwhile was cancelled only if the flag stopped it (not when its last statement finished).
    const stillRunning = () => this.running.get(queryId) === entry
    if (!stillRunning()) return entry.interrupted
    const canceller = await this.host.openCanceller(entry.ns)
    try {
      // Checked with the connection in hand: the target may have ended while it was being opened.
      if (!stillRunning()) return entry.interrupted
      const wasInFlight = entry.inFlight
      try {
        await canceller.cancel(backend)
        // Checked on both sides of the send so a statement that merely finished next to it is not counted.
        if (wasInFlight && entry.inFlight) entry.signalled = true
      } catch (err) {
        // The script loop is already stopped; a KILL that finds no such thread means the target just finished.
        if (stillRunning()) throw err
      }
      // The backend id is published before the first statement is sent, so a cancel issued right after "run"
      // can reach the server while the connection is still idle — a no-op on every dialect. Re-send it while a
      // statement is in flight; `inFlight` (not the registry alone) guards against interrupting the connection's
      // next borrower once the run has released it.
      for (let attempt = 0; attempt < CANCEL_RETRIES; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, CANCEL_RETRY_MS))
        if (!stillRunning() || !entry.inFlight) break
        // The first signal was delivered; a failing retry must not fail the request.
        await canceller.cancel(backend).then(
          () => {
            if (entry.inFlight) entry.signalled = true
          },
          () => undefined
        )
      }
      // The signal is out; the answer is what it did, known once the script loop reaches its next boundary
      // (a statement that resists — MySQL SLEEP returns normally when killed — still stops the script there).
      // A run that is still going after the wait is stopping: the flag holds until the loop looks at it.
      let timer: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        entry.settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), CANCEL_SETTLE_MS)
        }),
      ]).finally(() => clearTimeout(timer))
      return settled ? entry.interrupted || entry.signalled : true
    } finally {
      await canceller.close()
    }
  }
}
