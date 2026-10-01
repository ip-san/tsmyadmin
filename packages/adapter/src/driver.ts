/**
 * What a dialect's driver has to provide to BaseAdapter: a connection (`Conn`) that answers with normalised
 * results (`RawResult`), and a way to send a cancel signal from a second connection (`Canceller`). BaseAdapter and
 * the SQL console are written against these, never against mysql2 or pg.
 */
import type { Cell, ColumnMeta } from '@tsmyadmin/shared'
import type { QueryOptions } from './sql/cells.ts'
import { AdapterError } from './types.ts'

/** Normalised driver result: rows already converted to wire Cells. */
export interface RawResult {
  columns: ColumnMeta[]
  rows: Cell[][]
  affectedRows: number
  /** True when the statement produced a result set (even an empty one). */
  hasRows: boolean
  /** NOTICE / WARNING lines the server raised while running it (PostgreSQL). */
  notices?: string[]
}

/** A connection checked out of a pool and bound to a namespace. */
export interface Conn {
  query(text: string, params?: unknown[], options?: QueryOptions): Promise<RawResult | RawResult[]>
  release(): void
  /** Identity of the underlying pooled driver connection (stable across checkouts); used to cache session state. */
  readonly id: object
  /**
   * Restores the server-side session to its defaults (variables, roles, user variables, temp tables) so state
   * set by user SQL cannot leak to the next borrower. Implementations that cannot reset must discard the connection.
   */
  reset(): Promise<void>
  /** Drops any per-connection cache the dialect keeps (current database / search_path) so the next acquire re-applies it. */
  forget(): void
  /** Marks the connection as not reusable: release() closes it instead of returning it to the pool. */
  discard(): void
  /**
   * Whether the server considers a transaction to still be open on this connection. Only the server knows:
   * MySQL's implicit commits depend on the statement AND on how far it got (a DDL the parser rejected never
   * committed), which no amount of reading the script can reproduce.
   */
  inTransaction?(): Promise<boolean>
  /** PostgreSQL `COPY … FROM stdin` with the block's data (pg_dump's default format); absent on other dialects. */
  copyFrom?(sql: string, data: string): Promise<number>
  /**
   * Runs one SELECT and hands its rows over in batches as the driver reads them, so a full scan never holds the
   * whole result set (MySQL; PostgreSQL pages with a cursor instead). Every batch carries the column list; the
   * last one may be empty. Abandoning the iteration early discards the connection.
   */
  stream?(sql: string, params: unknown[], batchSize: number, options?: QueryOptions): AsyncIterable<RawResult>
}

/** One dedicated connection that sends cancel signals for a run (KILL QUERY / pg_cancel_backend). */
export interface Canceller {
  cancel(backendId: string): Promise<void>
  close(): Promise<void>
}

/** The first result of a call that may have returned several (a script's statements), or an empty one. */
export function firstResult(r: RawResult | RawResult[]): RawResult {
  if (Array.isArray(r)) {
    const first = r[0]
    if (!first) return { columns: [], rows: [], affectedRows: 0, hasRows: false }
    return first
  }
  return r
}

/**
 * How long a request waits for one of a session's four pooled connections before giving up, in both dialects.
 * Without a limit a pool held by long statements, scans or exports leaves every other request of the session
 * hanging with no answer; with one, the caller is told, and the browser can show it and retry.
 */
const ACQUIRE_TIMEOUT_MS = 10_000

/** What a request gets when no connection became free in time. */
export function poolBusyError(): AdapterError {
  return new AdapterError(
    'CONNECTION_FAILED',
    'No connection became free in time',
    'Every connection of this session is busy (a long statement, a scan or an export), or the server is slow to answer. Try again in a moment.'
  )
}

/**
 * A connection from `attempt`, or `poolBusyError()` once `ms` have passed. mysql2 queues a request for a connection
 * for as long as it takes and has no acquire timeout of its own (`queueLimit` only counts the queue); this is that
 * timeout. The queued request cannot be withdrawn, so when it is finally served after the caller gave up, the
 * connection goes straight back to the pool.
 */
export async function withinAcquireTimeout<C extends { release(): void }>(
  attempt: Promise<C>,
  ms: number = ACQUIRE_TIMEOUT_MS
): Promise<C> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('timed out')
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), ms)
  })
  try {
    const first = await Promise.race([attempt, timeout])
    if (first !== timedOut) return first
    attempt.then(
      (late) => late.release(),
      () => undefined
    )
    throw poolBusyError()
  } finally {
    clearTimeout(timer)
  }
}
