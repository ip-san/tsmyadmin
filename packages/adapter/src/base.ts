import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  ColumnMeta,
  Dialect,
  EventInfo,
  Filter,
  KeyValue,
  Namespace,
  ProcessInfo,
  RoutineInfo,
  RoutineKind,
  RowKey,
  RowKeyKind,
  RowValues,
  ServerInfo,
  StatementResult,
  TableInfo,
  TableSchema,
  TriggerInfo,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import { EXACT_COUNT_MAX_ROWS, isBinaryCell, isViewKind } from '@tsmyadmin/shared'
import { Params, quoteIdent, quoteTable } from './sql/quote.ts'
import { splitStatements } from './sql/split.ts'
import {
  AdapterError,
  type DatabaseAdapter,
  type DdlBuilder,
  type ExecuteOptions,
  type RowBatch,
  type SqlExporter,
  type UserSqlBuilder,
} from './types.ts'

/** Normalised driver result: rows already converted to wire Cells. */
export interface RawResult {
  columns: ColumnMeta[]
  rows: Cell[][]
  affectedRows: number
  /** True when the statement produced a result set (even an empty one). */
  hasRows: boolean
}

/** A connection checked out of a pool and bound to a namespace. */
export interface Conn {
  query(text: string, params?: unknown[]): Promise<RawResult | RawResult[]>
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
}

interface RunningEntry {
  ns: Namespace
  backend: Promise<string>
  cancelled: boolean
}

const READ_START = /^\s*(?:SELECT|WITH|VALUES|TABLE)\b/i
const NOT_WRAPPABLE = /\b(?:INTO|FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|LOCK\s+IN\s+SHARE\s+MODE)\b/i

const WRAP_PREFIX = 'SELECT * FROM ('

/** Subquery form of a plain read with a row cap, or null when the statement must run as written. */
export function wrapReadOnly(sql: string, limit: number): string | null {
  const body = sql.trim().replace(/;+\s*$/, '')
  if (!READ_START.test(body) || NOT_WRAPPABLE.test(body)) return null
  return `${WRAP_PREFIX}${body}) AS _tsmyadmin LIMIT ${Math.max(1, Math.floor(limit))}`
}

const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_BINARY_BYTES = 64 * 1024

/** Converts a wire Cell into a driver parameter. */
function toDbValue(cell: Cell): unknown {
  if (isBinaryCell(cell)) return Buffer.from(cell.$bin, 'base64')
  return cell
}

/** Truncates binaries for the wire. Returns [cell, truncated]. */
export function bufferToCell(buf: Uint8Array): [Cell, boolean] {
  const truncated = buf.byteLength > MAX_BINARY_BYTES
  const slice = truncated ? buf.subarray(0, MAX_BINARY_BYTES) : buf
  return [{ $bin: Buffer.from(slice).toString('base64') }, truncated]
}

const FILTER_SQL: Record<Filter['op'], string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  like: 'LIKE',
  not_like: 'NOT LIKE',
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
}

/** Exact COUNT(*) unless the catalog says the table is large (callers pass null when the browse is filtered). */
export function countMode(estimate: number | null, threshold = EXACT_COUNT_MAX_ROWS): 'exact' | 'estimate' {
  return estimate !== null && estimate > threshold ? 'estimate' : 'exact'
}

export function firstResult(r: RawResult | RawResult[]): RawResult {
  if (Array.isArray(r)) {
    const first = r[0]
    if (!first) return { columns: [], rows: [], affectedRows: 0, hasRows: false }
    return first
  }
  return r
}

/**
 * Dialect-independent implementation of browsing, row mutation and script execution.
 * Subclasses provide connections, value conversion, introspection and DDL.
 */
export abstract class BaseAdapter implements DatabaseAdapter {
  abstract readonly dialect: Dialect
  abstract readonly ddl: DdlBuilder
  abstract readonly exporter: SqlExporter
  abstract readonly users: UserSqlBuilder

  abstract ping(): Promise<void>
  abstract close(): Promise<void>
  abstract listDatabases(): Promise<{ name: string }[]>
  abstract listSchemas(database: string): Promise<string[]>
  abstract listTables(ns: Namespace): Promise<TableInfo[]>
  abstract describeTable(ns: Namespace, table: string): Promise<TableSchema>
  abstract listRoutines(ns: Namespace): Promise<RoutineInfo[]>
  abstract routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null>
  abstract listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]>
  abstract listEvents(ns: Namespace): Promise<EventInfo[]>
  abstract readonly serverNamespace: Namespace
  abstract showCreateTable(ns: Namespace, table: string, schema?: TableSchema): Promise<string[]>
  abstract serverInfo(): Promise<ServerInfo>
  abstract listVariables(): Promise<KeyValue[]>
  abstract listStatus(): Promise<KeyValue[]>
  abstract listProcesses(): Promise<ProcessInfo[]>
  abstract killProcess(id: string): Promise<void>
  abstract listUsers(): Promise<UserInfo[]>
  abstract showGrants(user: UserRef): Promise<string[]>

  /** Checks a connection out of the pool for `ns` (MySQL: `USE db` applied; PG: pool of that database). */
  protected abstract acquire(ns: Namespace): Promise<Conn>
  /** Applies / clears a per-session statement timeout. 0 clears. */
  protected abstract setStatementTimeout(conn: Conn, ms: number): Promise<void>
  /** Backend/connection id of `conn` as seen by the server (CONNECTION_ID() / pg_backend_pid()). */
  protected abstract backendId(conn: Conn): Promise<string>
  /** Interrupts the statement running on backend `id` from a fresh connection (KILL QUERY / pg_cancel_backend). */
  protected abstract cancelBackend(ns: Namespace, id: string): Promise<void>
  /** NULL-safe equality operator used for all-columns keys. */
  protected abstract nullSafeEq(): string
  /** Row-identity fallback when a table has no PK / NOT NULL unique key. */
  protected abstract fallbackKeyKind(): Extract<RowKeyKind, 'ctid' | 'all-columns'>
  /** Extra SELECT-list expression that exposes the fallback key (PG: ctid), or null. */
  protected abstract fallbackKeySelect(): string | null

  /**
   * Statement timeout currently applied to each pooled driver connection. The timeout is left in place on
   * release and only re-sent when the next borrower needs a different value, so the common path (every call
   * using the default timeout) costs no extra round trips. Entries are dropped when user SQL may have changed it.
   */
  private readonly appliedTimeout = new WeakMap<object, number>()

  /** Checks out a connection with the statement timeout applied; `done()` mirrors withConn's cleanup. */
  private async borrow(ns: Namespace, timeoutMs: number): Promise<{ conn: Conn; done: () => Promise<void> }> {
    const conn = await this.acquire(ns)
    if (this.appliedTimeout.get(conn.id) !== timeoutMs) {
      try {
        await this.setStatementTimeout(conn, timeoutMs)
        this.appliedTimeout.set(conn.id, timeoutMs)
      } catch (err) {
        this.appliedTimeout.delete(conn.id)
        conn.release()
        throw err
      }
    }
    return { conn, done: () => Promise.resolve(conn.release()) }
  }

  /**
   * Forgets the cached session state of `conn` (after user-controlled SQL that may have issued its own SET /
   * USE / search_path change): the timeout cache here and the dialect's namespace cache via `conn.forget()`.
   */
  protected forgetSessionState(conn: Conn): void {
    this.appliedTimeout.delete(conn.id)
    conn.forget()
  }

  protected async withConn<T>(
    ns: Namespace,
    fn: (conn: Conn) => Promise<T>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const { conn, done } = await this.borrow(ns, timeoutMs)
    try {
      return await fn(conn)
    } finally {
      await done()
    }
  }

  protected async withTransaction<T>(ns: Namespace, fn: (conn: Conn) => Promise<T>): Promise<T> {
    return this.withConn(ns, async (conn) => {
      await conn.query('BEGIN')
      try {
        const result = await fn(conn)
        await conn.query('COMMIT')
        return result
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => undefined)
        throw err
      }
    })
  }

  /** Resolves how rows of `schema` can be addressed. */
  resolveRowKey(schema: TableSchema): { keyKind: RowKeyKind; keyColumns: string[] } {
    if (isViewKind(schema.kind)) return { keyKind: 'none', keyColumns: [] }
    if (schema.primaryKey.length > 0) return { keyKind: 'pk', keyColumns: schema.primaryKey }
    const notNull = new Set(schema.columns.filter((c) => !c.nullable).map((c) => c.name))
    // A partial unique index does not identify every row (duplicates are allowed outside its predicate).
    const unique = schema.indexes.find(
      (i) => i.unique && i.predicate === null && i.columns.every((c) => notNull.has(c))
    )
    if (unique) return { keyKind: 'pk', keyColumns: unique.columns }
    const kind = this.fallbackKeyKind()
    return { keyKind: kind, keyColumns: kind === 'ctid' ? ['ctid'] : schema.columns.map((c) => c.name) }
  }

  async browseRows(ns: Namespace, table: string, opts: BrowseOptions): Promise<BrowseResult> {
    const schema = await this.describeTable(ns, table)
    const known = new Set(schema.columns.map((c) => c.name))
    for (const s of opts.sort)
      if (!known.has(s.column)) throw new AdapterError('NOT_FOUND', `Unknown column: ${s.column}`)
    for (const f of opts.filters)
      if (!known.has(f.column)) throw new AdapterError('NOT_FOUND', `Unknown column: ${f.column}`)

    const d = this.dialect
    const key = this.resolveRowKey(schema)
    const params = new Params(d)
    const where = this.buildWhere(opts.filters, params)
    const tableSql = quoteTable(d, ns, table)
    const selectList = schema.columns.map((c) => quoteIdent(d, c.name))
    const fallback = this.fallbackKeySelect()
    if (key.keyKind === 'ctid' && fallback) selectList.push(fallback)
    const order =
      opts.sort.length > 0
        ? ` ORDER BY ${opts.sort.map((s) => `${quoteIdent(d, s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
        : ''
    const limit = ` LIMIT ${params.add(opts.limit)} OFFSET ${params.add(opts.offset)}`
    const dataSql = `SELECT ${selectList.join(', ')} FROM ${tableSql}${where}${order}${limit}`

    const countParams = new Params(d)
    const countWhere = this.buildWhere(opts.filters, countParams)
    const countSql = `SELECT COUNT(*) FROM ${tableSql}${countWhere}`

    return this.withConn(ns, async (conn) => {
      const data = firstResult(await conn.query(dataSql, params.values))
      // Large unfiltered tables: COUNT(*) is a full scan on InnoDB / PostgreSQL, so use the catalog estimate
      // that describeTable already fetched (no extra round trip).
      const estimate = opts.filters.length === 0 ? schema.rowEstimate : null
      if (countMode(estimate) === 'estimate') {
        return {
          columns: data.columns,
          rows: data.rows,
          truncated: false,
          total: estimate,
          approximate: true,
          keyKind: key.keyKind,
          keyColumns: key.keyColumns,
          foreignKeys: schema.foreignKeys,
          referencedBy: schema.referencedBy,
        }
      }
      const count = firstResult(await conn.query(countSql, countParams.values))
      const totalCell = count.rows[0]?.[0]
      const total = typeof totalCell === 'number' ? totalCell : typeof totalCell === 'string' ? Number(totalCell) : null
      return {
        columns: data.columns,
        rows: data.rows,
        truncated: false,
        total: total !== null && Number.isFinite(total) ? total : null,
        approximate: false,
        keyKind: key.keyKind,
        keyColumns: key.keyColumns,
        foreignKeys: schema.foreignKeys,
        referencedBy: schema.referencedBy,
      }
    })
  }

  private buildWhere(filters: Filter[], params: Params): string {
    if (filters.length === 0) return ''
    const parts = filters.map((f) => {
      const col = quoteIdent(this.dialect, f.column)
      const op = FILTER_SQL[f.op]
      if (f.op === 'is_null' || f.op === 'is_not_null') return `${col} ${op}`
      if (f.value === undefined)
        throw new AdapterError('QUERY_FAILED', `Filter "${f.op}" on ${f.column} requires a value`)
      return `${col} ${op} ${params.add(toDbValue(f.value))}`
    })
    return ` WHERE ${parts.join(' AND ')}`
  }

  async insertRow(ns: Namespace, table: string, values: RowValues): Promise<{ affectedRows: number }> {
    const d = this.dialect
    const names = Object.keys(values)
    const params = new Params(d)
    const sql =
      names.length === 0
        ? d === 'mysql'
          ? `INSERT INTO ${quoteTable(d, ns, table)} () VALUES ()`
          : `INSERT INTO ${quoteTable(d, ns, table)} DEFAULT VALUES`
        : `INSERT INTO ${quoteTable(d, ns, table)} (${names.map((n) => quoteIdent(d, n)).join(', ')}) VALUES (${names
            .map((n) => params.add(toDbValue(values[n] ?? null)))
            .join(', ')})`
    return this.withConn(ns, async (conn) => {
      const r = firstResult(await conn.query(sql, params.values))
      return { affectedRows: r.affectedRows }
    })
  }

  /** Rows per INSERT statement, bounded so PostgreSQL's 65535-parameter limit is never hit. */
  static chunkSize(columnCount: number): number {
    return Math.max(1, Math.min(500, Math.floor(30_000 / Math.max(1, columnCount))))
  }

  async insertRows(ns: Namespace, table: string, columns: string[], rows: Cell[][]): Promise<{ affectedRows: number }> {
    if (columns.length === 0) throw new AdapterError('QUERY_FAILED', 'insertRows requires at least one column')
    if (rows.length === 0) return { affectedRows: 0 }
    const d = this.dialect
    const head = `INSERT INTO ${quoteTable(d, ns, table)} (${columns.map((c) => quoteIdent(d, c)).join(', ')}) VALUES `
    const chunk = BaseAdapter.chunkSize(columns.length)
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      for (let i = 0; i < rows.length; i += chunk) {
        const params = new Params(d)
        const values = rows
          .slice(i, i + chunk)
          .map((row) => `(${columns.map((_, j) => params.add(toDbValue(row[j] ?? null))).join(', ')})`)
          .join(', ')
        const r = firstResult(await conn.query(head + values, params.values))
        affected += r.affectedRows
      }
      return { affectedRows: affected }
    })
  }

  async updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }> {
    const d = this.dialect
    const names = Object.keys(values)
    if (names.length === 0) return { affectedRows: 0 }
    const params = new Params(d)
    const set = names.map((n) => `${quoteIdent(d, n)} = ${params.add(toDbValue(values[n] ?? null))}`).join(', ')
    const where = this.buildKeyWhere(key, params)
    const limit = key.kind === 'all-columns' && d === 'mysql' ? ' LIMIT 1' : ''
    const sql = `UPDATE ${quoteTable(d, ns, table)} SET ${set}${where}${limit}`
    return this.withTransaction(ns, async (conn) => {
      const r = firstResult(await conn.query(sql, params.values))
      if (r.affectedRows !== 1) {
        throw new AdapterError(
          'KEY_MISMATCH',
          `Expected to update exactly 1 row but matched ${r.affectedRows}; rolled back`
        )
      }
      return { affectedRows: r.affectedRows }
    })
  }

  async deleteRows(ns: Namespace, table: string, keys: RowKey[]): Promise<{ affectedRows: number }> {
    const d = this.dialect
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      for (const key of keys) {
        const params = new Params(d)
        const where = this.buildKeyWhere(key, params)
        const limit = key.kind === 'all-columns' && d === 'mysql' ? ' LIMIT 1' : ''
        const r = firstResult(
          await conn.query(`DELETE FROM ${quoteTable(d, ns, table)}${where}${limit}`, params.values)
        )
        if (r.affectedRows !== 1) {
          throw new AdapterError(
            'KEY_MISMATCH',
            `Expected to delete exactly 1 row but matched ${r.affectedRows}; rolled back`
          )
        }
        affected += r.affectedRows
      }
      return { affectedRows: affected }
    })
  }

  private buildKeyWhere(key: RowKey, params: Params): string {
    const d = this.dialect
    switch (key.kind) {
      case 'pk': {
        const names = Object.keys(key.values)
        if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Primary key values are empty')
        return ` WHERE ${names.map((n) => `${quoteIdent(d, n)} = ${params.add(toDbValue(key.values[n] ?? null))}`).join(' AND ')}`
      }
      case 'all-columns': {
        if (d !== 'mysql') throw new AdapterError('UNSUPPORTED', 'all-columns keys are only supported on MySQL')
        const names = Object.keys(key.values)
        if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Key values are empty')
        const eq = this.nullSafeEq()
        return ` WHERE ${names.map((n) => `${quoteIdent(d, n)} ${eq} ${params.add(toDbValue(key.values[n] ?? null))}`).join(' AND ')}`
      }
      case 'ctid': {
        if (d !== 'postgres') throw new AdapterError('UNSUPPORTED', 'ctid keys are only supported on PostgreSQL')
        return ` WHERE ctid = ${params.add(key.value)}::tid`
      }
    }
  }

  /**
   * Stable-order full scan with keyset pagination: PK (or NOT NULL unique key) → `WHERE (k1, k2) > (last)`
   * ordered by the key; PostgreSQL without a key → `WHERE ctid > last` ordered by ctid; MySQL without a key →
   * a single unordered batch (no total order exists to page over). Keyset paging keeps each batch O(batch)
   * instead of OFFSET's O(offset + batch) rescans on large tables.
   */
  async *iterateRows(
    ns: Namespace,
    table: string,
    opts: { batchSize: number; schema?: TableSchema }
  ): AsyncIterable<RowBatch> {
    const schema = opts.schema ?? (await this.describeTable(ns, table))
    const key = this.resolveRowKey(schema)
    const d = this.dialect
    const columns = schema.columns.map((c) => quoteIdent(d, c.name))
    const tableSql = quoteTable(d, ns, table)
    const fallback = this.fallbackKeySelect()
    const byCtid = key.keyKind === 'ctid' && fallback !== null
    const keyExprs = key.keyKind === 'pk' ? key.keyColumns.map((c) => quoteIdent(d, c)) : byCtid ? ['ctid'] : []
    // Position of each key column in the selected row (ctid is appended as an extra trailing column).
    const keyIndexes =
      key.keyKind === 'pk' ? key.keyColumns.map((c) => schema.columns.findIndex((col) => col.name === c)) : []
    if (keyIndexes.includes(-1)) throw new AdapterError('QUERY_FAILED', 'Key column missing from table schema')
    const selectList = byCtid && fallback ? [...columns, fallback] : columns
    const orderBy = keyExprs.length > 0 ? ` ORDER BY ${keyExprs.join(', ')}` : ''
    const single = orderBy === ''
    const batchSize = Math.max(1, Math.floor(opts.batchSize))
    // Generators cannot run inside withConn's callback, so the borrow/done pair is shared instead
    // (no statement timeout: full scans may legitimately be long).
    const { conn, done } = await this.borrow(ns, 0)
    try {
      let last: Cell[] | null = null
      let first = true
      for (;;) {
        const params = new Params(d)
        let where = ''
        if (last) {
          if (byCtid) where = ` WHERE ctid > ${params.add(last[last.length - 1])}::tid`
          else {
            const lastRow = last
            const lastKey = keyIndexes.map((i) => params.add(toDbValue(lastRow[i] ?? null)))
            where = ` WHERE (${keyExprs.join(', ')}) > (${lastKey.join(', ')})`
          }
        }
        const limit = single ? '' : ` LIMIT ${params.add(batchSize)}`
        const r = firstResult(
          await conn.query(`SELECT ${selectList.join(', ')} FROM ${tableSql}${where}${orderBy}${limit}`, params.values)
        )
        const rows = byCtid ? r.rows.map((row) => row.slice(0, -1)) : r.rows
        const cols = byCtid ? r.columns.slice(0, -1) : r.columns
        // An empty table still yields one batch so callers learn the column list.
        if (rows.length > 0 || first) yield { columns: cols, rows }
        first = false
        if (single || r.rows.length < batchSize) return
        last = r.rows[r.rows.length - 1] ?? null
      }
    } finally {
      await done()
    }
  }

  /**
   * Running executeSql calls by queryId. The entry is registered synchronously when executeSql starts so a
   * cancel that arrives while the connection is still being acquired waits for the backend id instead of missing.
   */
  private readonly running = new Map<string, RunningEntry>()

  async executeSql(ns: Namespace, script: string, opts: ExecuteOptions): Promise<StatementResult[]> {
    const statements = splitStatements(script, this.dialect)
    const results: StatementResult[] = []
    const emit = async (r: StatementResult) => {
      results.push(r)
      await opts.onResult?.(r, results.length - 1)
    }
    let resolveBackend: (id: string) => void = () => undefined
    const entry: RunningEntry = {
      ns,
      backend: new Promise<string>((resolve) => {
        resolveBackend = resolve
      }),
      cancelled: false,
    }
    if (opts.queryId) this.running.set(opts.queryId, entry)
    try {
      await this.withConn(
        ns,
        async (conn) => {
          try {
            if (opts.queryId) resolveBackend(await this.backendId(conn))
            // User SQL may SET the session timeout / namespace itself; never trust the cached values afterwards.
            this.forgetSessionState(conn)
            for (const st of statements) {
              if (entry.cancelled) break
              const started = performance.now()
              try {
                const list = await this.runStatement(conn, st.sql, opts.maxRows, () => entry.cancelled)
                const durationMs = Math.round(performance.now() - started)
                for (const r of list) {
                  if (r.hasRows) {
                    const truncated = r.rows.length > opts.maxRows
                    await emit({
                      kind: 'rows',
                      sql: st.sql,
                      durationMs,
                      result: {
                        columns: r.columns,
                        rows: truncated ? r.rows.slice(0, opts.maxRows) : r.rows,
                        truncated,
                      },
                    })
                  } else {
                    await emit({ kind: 'affected', sql: st.sql, durationMs, affectedRows: r.affectedRows })
                  }
                }
              } catch (err) {
                const e = err instanceof AdapterError ? err : this.toAdapterError(err)
                await emit({
                  kind: 'error',
                  sql: st.sql,
                  message: e.detail ?? e.message,
                  code: e.code,
                  ...(e.nativeCode ? { nativeCode: e.nativeCode } : {}),
                  ...(e.position ? { position: e.position } : {}),
                })
                if (opts.stopOnError) break
              }
            }
          } finally {
            // Each execution is autocommitted: a transaction the script left open (or aborted) must not leak
            // into the next borrower of this pooled connection — nor may any session state the script set
            // (autocommit, sql_mode, SET ROLE, user variables, ...), hence the full session reset afterwards.
            // In a finally so an onResult/backendId failure cannot return a dirty connection to the pool.
            await conn.query('ROLLBACK').catch(() => undefined)
            await conn.reset()
          }
        },
        opts.timeoutMs
      )
    } finally {
      if (opts.queryId) {
        this.running.delete(opts.queryId)
        resolveBackend('') // release any waiting cancelQuery
      }
    }
    return results
  }

  /**
   * Runs one user statement. A plain read (SELECT / WITH / VALUES / TABLE without INTO or row locks) is wrapped
   * as `SELECT * FROM (...) AS _tsmyadmin LIMIT maxRows + 1` so a `SELECT * FROM huge_table` never materialises
   * the whole table in this process; the extra row is how the caller detects truncation. Error positions are
   * shifted back by the wrapper prefix. MySQL rejects derived tables with duplicate column names
   * (`SELECT * FROM a JOIN b` sharing `id`), the one case where the statement is re-run as written — never after
   * an interruption, which would restart the very statement that was just cancelled.
   */
  private async runStatement(conn: Conn, sql: string, maxRows: number, cancelled: () => boolean): Promise<RawResult[]> {
    const asList = (raw: RawResult | RawResult[]) => (Array.isArray(raw) ? raw : [raw])
    const wrapped = wrapReadOnly(sql, maxRows + 1)
    if (!wrapped) return asList(await conn.query(sql))
    try {
      return asList(await conn.query(wrapped))
    } catch (err) {
      const e = err instanceof AdapterError ? err : this.toAdapterError(err)
      if (this.dialect === 'mysql' && e.nativeCode === 'ER_DUP_FIELDNAME' && !cancelled()) {
        return asList(await conn.query(sql))
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
  async cancelQuery(queryId: string, waitMs = 10_000): Promise<boolean> {
    const entry = this.running.get(queryId)
    if (!entry) return false
    const backend = await Promise.race([
      entry.backend,
      new Promise<string>((resolve) => setTimeout(() => resolve(''), waitMs)),
    ])
    if (!/^\d+$/.test(backend)) return false
    // Also stop the script loop: with stopOnError=false the run would otherwise continue with the next statement.
    entry.cancelled = true
    await this.cancelBackend(entry.ns, backend)
    return true
  }

  /** Maps a driver error to AdapterError. */
  abstract toAdapterError(err: unknown): AdapterError
}
