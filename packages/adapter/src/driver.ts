/**
 * What a dialect's driver has to provide to BaseAdapter: a connection (`Conn`) that answers with normalised
 * results (`RawResult`), and a way to send a cancel signal from a second connection (`Canceller`). BaseAdapter and
 * the SQL console are written against these, never against mysql2 or pg.
 */
import type { Cell, ColumnMeta } from '@tsmyadmin/shared'
import type { QueryOptions } from './sql/cells.ts'

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
