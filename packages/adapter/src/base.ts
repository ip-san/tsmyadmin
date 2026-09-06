import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  ColumnMeta,
  DatabaseInfo,
  Dialect,
  EventInfo,
  Filter,
  InputCell,
  KeyValue,
  Namespace,
  ObjectDependency,
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
import { EXACT_COUNT_MAX_ROWS, isBinaryCell, isTruncatedCell, isViewKind, MAX_TEXT_CHARS } from '@tsmyadmin/shared'
import { Params, quoteIdent, quoteTable } from './sql/quote.ts'
import { splitStatements, stripLeadingComments } from './sql/split.ts'
import {
  AdapterError,
  type DatabaseAdapter,
  type DdlBuilder,
  type ExecuteOptions,
  type InsertRowsOptions,
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
  /** NOTICE / WARNING lines the server raised while running it (PostgreSQL). */
  notices?: string[]
}

/** A connection checked out of a pool and bound to a namespace. */
/** Per-query options handed to the driver layer. */
export interface QueryOptions {
  /** Bytes kept of each binary value (default MAX_BINARY_BYTES for display; Infinity for exports). */
  binaryLimit?: number
  /**
   * Characters kept of each text value. Unlimited by default: catalog reads (a view definition, a routine body,
   * SHOW CREATE TABLE) must arrive whole. Only the rows shown to the user (browse pages, console results) pass
   * DISPLAY.
   */
  textLimit?: number
}

/** Export reads: whole values, whatever their size. */
export const UNCAPPED: QueryOptions = { binaryLimit: Number.POSITIVE_INFINITY, textLimit: Number.POSITIVE_INFINITY }
/** Rows rendered on a page: a multi-megabyte TEXT / JSON cell travels as its head plus its length. */
const DISPLAY: QueryOptions = { textLimit: MAX_TEXT_CHARS }

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
  /** PostgreSQL `COPY … FROM stdin` with the block's data (pg_dump's default format); absent on other dialects. */
  copyFrom?(sql: string, data: string): Promise<number>
  /**
   * Runs one SELECT and hands its rows over in batches as the driver reads them, so a full scan never holds the
   * whole result set (MySQL; PostgreSQL pages with a cursor instead). Every batch carries the column list; the
   * last one may be empty. Abandoning the iteration early discards the connection.
   */
  stream?(sql: string, params: unknown[], batchSize: number, options?: QueryOptions): AsyncIterable<RawResult>
}

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
  /** Resolves when the run has ended, whatever the outcome. */
  settled: Promise<void>
  /** True while a statement is on the wire; a cancel that lands on an idle connection is a no-op and is retried. */
  inFlight: boolean
  /** The cancel in progress, shared by concurrent cancel requests for the same run. */
  cancelling: Promise<boolean> | null
}

/** One dedicated connection that sends cancel signals for a run (KILL QUERY / pg_cancel_backend). */
export interface Canceller {
  cancel(backendId: string): Promise<void>
  close(): Promise<void>
}

const CANCEL_RETRY_MS = 50
const CANCEL_RETRIES = 40
/** How long a cancel waits for the script loop to report what the signal did before answering "stopping". */
const CANCEL_SETTLE_MS = 10_000

const READ_START = /^\s*(?:\(|(?:SELECT|WITH|VALUES|TABLE)\b)/i
const NOT_WRAPPABLE =
  /\b(?:INTO|FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|LOCK\s+IN\s+SHARE\s+MODE|INSERT|UPDATE|DELETE|MERGE)\b/i
/** Leading whitespace and comments (kept in Statement.sql so the user sees what ran, ignored for the wrap test). */

/** String literals, quoted identifiers, dollar-quoted bodies and comments, replaced by a space (`'delete'` is data, not DML). */
const LITERALS_AND_COMMENTS =
  /\bE'(?:[^'\\]|\\.|'')*'|'(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g

const LITERALS_AND_COMMENTS_STANDARD =
  /\bE'(?:[^'\\]|\\.|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)[\s\S]*?\1|--[^\n]*|\/\*[\s\S]*?\*\//g

/** Backslashes escape quotes in MySQL strings; in PostgreSQL only inside E'...' (standard_conforming_strings). */
function stripLiterals(code: string, dialect: Dialect): string {
  return code.replace(dialect === 'mysql' ? LITERALS_AND_COMMENTS : LITERALS_AND_COMMENTS_STANDARD, ' ')
}

const WRAP_PREFIX = 'SELECT * FROM (\n'
const NO_CODES: ReadonlySet<string> = new Set()
/** A statement's own LIMIT takes precedence over MySQL's sql_select_limit. */
const HAS_LIMIT = /\bLIMIT\b/i
const TOUCHES_CAP = /sql_select_limit/i

/**
 * Subquery form of a plain read with a row cap, or null when the statement must run as written. The body is
 * placed on its own line so a trailing `--` comment cannot swallow the closing parenthesis; data-modifying
 * statements (also inside a WITH) are never wrapped.
 */
export function wrapReadOnly(sql: string, limit: number, dialect: Dialect = 'postgres'): string | null {
  const body = sql.trim().replace(/;+\s*$/, '')
  const code = stripLeadingComments(body, dialect)
  if (!READ_START.test(code) || NOT_WRAPPABLE.test(stripLiterals(code, dialect))) return null
  return `${WRAP_PREFIX}${body}\n) AS _tsmyadmin LIMIT ${Math.max(1, Math.floor(limit))}`
}

const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_BINARY_BYTES = 64 * 1024

/** Converts a wire Cell into a driver parameter. */
function toDbValue(cell: Cell): unknown {
  if (isBinaryCell(cell)) return Buffer.from(cell.$bin, 'base64')
  // The schemas already reject it at the API; this guards adapter-internal callers (row keys built from a page).
  if (isTruncatedCell(cell)) throw new AdapterError('VALIDATION', 'a truncated text value cannot be written back')
  return cell
}

/** Binary cell for the wire, cut at `limit` bytes (display) or kept whole (`Infinity`, exports). */
function bufferToCell(buf: Uint8Array, limit = MAX_BINARY_BYTES): Cell {
  const slice = buf.byteLength > limit ? buf.subarray(0, limit) : buf
  return { $bin: Buffer.from(slice).toString('base64') }
}

/**
 * Converts a driver value into a wire Cell (both drivers are configured to return BIGINT/DECIMAL/dates as
 * strings already; binaries arrive as Buffers, JSON as text or objects).
 */
export function driverValueToCell(value: unknown, options: QueryOptions = {}): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return bufferToCell(value, options.binaryLimit)
  switch (typeof value) {
    case 'string': {
      const limit = options.textLimit ?? Number.POSITIVE_INFINITY
      if (value.length <= limit) return value
      // Cut between code points: a high surrogate at the edge would leave a lone half of a character.
      const cut = value.charCodeAt(limit - 1)
      const end = cut >= 0xd800 && cut <= 0xdbff ? limit - 1 : limit
      return { $text: value.slice(0, end), length: value.length }
    }
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    default:
      return JSON.stringify(value)
  }
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
  contains: 'LIKE',
  starts_with: 'LIKE',
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
}

/**
 * Escapes LIKE metacharacters so a user string matches literally. `!` is the escape character (declared with
 * ESCAPE '!'): unlike a backslash it needs no dialect-specific string escaping of its own.
 */
export function escapeLike(text: string): string {
  return text.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')
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
  abstract listDatabases(): Promise<DatabaseInfo[]>
  abstract listSchemas(database: string): Promise<string[]>
  abstract listTables(ns: Namespace): Promise<TableInfo[]>
  abstract describeTable(ns: Namespace, table: string): Promise<TableSchema>
  abstract listRoutines(ns: Namespace): Promise<RoutineInfo[]>
  abstract routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null>
  abstract listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]>
  abstract listEvents(ns: Namespace): Promise<EventInfo[]>
  abstract listDependencies(ns: Namespace): Promise<ObjectDependency[] | null>
  abstract readonly serverNamespace: Namespace
  abstract showCreateTable(ns: Namespace, table: string, schema?: TableSchema): Promise<string[]>
  abstract serverInfo(): Promise<ServerInfo>
  abstract listVariables(): Promise<KeyValue[]>
  abstract listStatus(): Promise<KeyValue[]>
  abstract listProcesses(): Promise<ProcessInfo[]>
  abstract killProcess(id: string): Promise<void>
  abstract listUsers(): Promise<UserInfo[]>
  abstract showGrants(user: UserRef, ns?: Namespace): Promise<string[]>

  /** Checks a connection out of the pool for `ns` (MySQL: `USE db` applied; PG: pool of that database). */
  protected abstract acquire(ns: Namespace): Promise<Conn>
  /** Applies / clears a per-session statement timeout. 0 clears. */
  protected abstract setStatementTimeout(conn: Conn, ms: number): Promise<void>
  /** Backend/connection id of `conn` as seen by the server (CONNECTION_ID() / pg_backend_pid()). */
  protected abstract backendId(conn: Conn): Promise<string>
  /**
   * Opens one dedicated connection for cancel signals (KILL QUERY / pg_cancel_backend). Dedicated, because the
   * session's pool may be fully occupied by the very statements being cancelled; one per cancel (not per
   * signal), because the retry loop would otherwise open a fresh connection every 50 ms.
   */
  protected abstract openCanceller(ns: Namespace): Promise<Canceller>
  /** NULL-safe equality operator used for all-columns keys. */
  protected abstract nullSafeEq(): string
  /**
   * Called once per executeSql before the first statement (and again after a statement that touched the
   * setting). A dialect that can cap result sets session-wide (MySQL / MariaDB `sql_select_limit`) does it
   * here and returns true so plain reads are not wrapped in a derived table — MariaDB drops the inner ORDER BY
   * of a merged derived table, MySQL rejects duplicate column names and top-level-only modifiers inside one.
   * A statement with its own LIMIT overrides the session cap and is still wrapped (a derived table with a
   * LIMIT is materialised, so its ORDER BY survives). The session reset after the script clears the setting.
   */
  protected async capResultRows(_conn: Conn, _maxRows: number): Promise<boolean> {
    return false
  }
  /** Native error codes that mean "the read-only wrapper broke this statement", after which it is re-run unwrapped. */
  protected wrapperOnlyErrors(): ReadonlySet<string> {
    return NO_CODES
  }
  /** Row-identity fallback when a table has no PK / NOT NULL unique key. */
  protected abstract fallbackKeyKind(): Extract<RowKeyKind, 'ctid' | 'all-columns'>
  /** Extra SELECT-list expression that exposes the fallback key (PG: ctid), or null. */
  protected abstract fallbackKeySelect(): string | null
  /**
   * Wraps a key-value placeholder so it compares as the column's own type (`dataType` as reported by describeTable).
   * Dialects whose placeholders reach the server as untyped literals override this (MySQL JSON / FLOAT / DECIMAL).
   */
  protected keyParam(placeholder: string, _type: string): string {
    return placeholder
  }
  /** Expression a key column is ordered and compared by in keyset paging (MySQL ENUM/SET: label, not index). */
  protected keyColumnExpr(quoted: string, _type: string): string {
    return quoted
  }
  /** Whether keyParam needs the column types (saves the describeTable round trips on dialects that never cast). */
  protected readonly castsKeyParams: boolean = false

  /** Column name → declared type, for keyParam; empty when the dialect never casts. */
  private async keyColumnTypes(ns: Namespace, table: string): Promise<Map<string, string>> {
    if (!this.castsKeyParams) return new Map()
    const schema = await this.describeTable(ns, table)
    return new Map(schema.columns.map((c) => [c.name, c.dataType]))
  }

  /**
   * Statement timeout currently applied to each pooled driver connection. The timeout is left in place on
   * release and only re-sent when the next borrower needs a different value, so the common path (every call
   * using the default timeout) costs no extra round trips. Entries are dropped when user SQL may have changed it.
   */
  private readonly appliedTimeout = new WeakMap<object, number>()

  /** Checks out a connection with the statement timeout applied; `done()` mirrors withConn's cleanup. */
  protected async borrow(ns: Namespace, timeoutMs: number): Promise<{ conn: Conn; done: () => Promise<void> }> {
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
    // ctid is unique per physical relation only: a partitioned / inheritance parent repeats it across children.
    if (kind === 'ctid' && (schema.partitioned || schema.hasChildren)) return { keyKind: 'none', keyColumns: [] }
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
    const types = new Map(schema.columns.map((c) => [c.name, c.dataType]))
    const where = this.buildWhere(opts.filters, params, types)
    const tableSql = quoteTable(d, ns, table)
    const selectList = schema.columns.map((c) => quoteIdent(d, c.name))
    const fallback = this.fallbackKeySelect()
    if (key.keyKind === 'ctid' && fallback) selectList.push(fallback)
    // Without a user sort the rows still come in a stable order (LIMIT / OFFSET paging over heap order can
    // skip or repeat rows): the primary key (an index scan), or ctid on PostgreSQL — which is a full scan plus
    // a sort per page, so only while the table is small enough to be counted exactly anyway.
    const defaultOrder =
      key.keyKind === 'pk'
        ? key.keyColumns.map((c) => quoteIdent(d, c)).join(', ')
        : key.keyKind === 'ctid' && countMode(schema.rowEstimate) === 'exact'
          ? `${tableSql}.ctid`
          : ''
    const order =
      opts.sort.length > 0
        ? ` ORDER BY ${opts.sort.map((s) => `${quoteIdent(d, s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
        : defaultOrder
          ? ` ORDER BY ${defaultOrder}`
          : ''
    const limit = ` LIMIT ${params.add(opts.limit)} OFFSET ${params.add(opts.offset)}`
    const dataSql = `SELECT ${selectList.join(', ')} FROM ${tableSql}${where}${order}${limit}`

    // The count stops at the threshold: a filter matching millions of rows costs one bounded scan, and the page
    // then says "100,000+" instead of the exact figure.
    const countParams = new Params(d)
    const countWhere = this.buildWhere(opts.filters, countParams, types)
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${tableSql}${countWhere} LIMIT ${countParams.add(EXACT_COUNT_MAX_ROWS + 1)}) AS tsmyadmin_count`

    return this.withConn(ns, async (conn) => {
      const data = firstResult(await conn.query(dataSql, params.values, DISPLAY))
      // Large unfiltered tables: COUNT(*) is a full scan on InnoDB / PostgreSQL, so use the catalog estimate
      // that describeTable already fetched (no extra round trip).
      const estimate = opts.filters.length === 0 ? schema.rowEstimate : null
      if (countMode(estimate) === 'estimate') {
        return {
          columns: data.columns,
          rows: data.rows,
          truncated: false,
          total: estimate,
          count: 'estimate',
          keyKind: key.keyKind,
          keyColumns: key.keyColumns,
          foreignKeys: schema.foreignKeys,
          referencedBy: schema.referencedBy,
        }
      }
      const count = firstResult(await conn.query(countSql, countParams.values))
      const totalCell = count.rows[0]?.[0]
      const counted =
        typeof totalCell === 'number' ? totalCell : typeof totalCell === 'string' ? Number(totalCell) : null
      const total = counted !== null && Number.isFinite(counted) ? counted : null
      const bounded = total !== null && total > EXACT_COUNT_MAX_ROWS
      return {
        columns: data.columns,
        rows: data.rows,
        truncated: false,
        total: bounded ? EXACT_COUNT_MAX_ROWS : total,
        count: bounded ? 'lower_bound' : 'exact',
        keyKind: key.keyKind,
        keyColumns: key.keyColumns,
        foreignKeys: schema.foreignKeys,
        referencedBy: schema.referencedBy,
      }
    })
  }

  private buildWhere(filters: Filter[], params: Params, types: Map<string, string>): string {
    if (filters.length === 0) return ''
    const parts = filters.map((f) => {
      const col = quoteIdent(this.dialect, f.column)
      const op = FILTER_SQL[f.op]
      if (f.op === 'is_null' || f.op === 'is_not_null') return `${col} ${op}`
      if (f.value === undefined)
        throw new AdapterError('QUERY_FAILED', `Filter "${f.op}" on ${f.column} requires a value`)
      // PostgreSQL has no implicit cast for LIKE on numbers / dates / json; match against the text form.
      const likeCol = this.dialect === 'postgres' ? `${col}::text` : col
      if (f.op === 'contains' || f.op === 'starts_with') {
        // The user's text is matched literally: LIKE metacharacters are escaped, wildcards added here.
        const text = escapeLike(String(f.value ?? ''))
        const pattern = f.op === 'contains' ? `%${text}%` : `${text}%`
        return `${likeCol} LIKE ${params.add(pattern)} ESCAPE '!'`
      }
      if (f.op === 'like' || f.op === 'not_like') return `${likeCol} ${op} ${params.add(toDbValue(f.value))}`
      // Comparisons use the column's own type (FLOAT 0.1 is not the DOUBLE literal 0.1; BIT is not a hex string).
      return `${col} ${op} ${this.keyParam(params.add(toDbValue(f.value)), types.get(f.column) ?? '')}`
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

  async insertRows(
    ns: Namespace,
    table: string,
    columns: string[],
    rows: Iterable<InputCell[]>,
    options: InsertRowsOptions = {}
  ): Promise<{ affectedRows: number }> {
    if (columns.length === 0) throw new AdapterError('QUERY_FAILED', 'insertRows requires at least one column')
    const d = this.dialect
    // A PostgreSQL identity column declared ALWAYS refuses explicit values without OVERRIDING SYSTEM VALUE.
    const overriding = d === 'postgres' && options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''
    const head = `INSERT INTO ${quoteTable(d, ns, table)} (${columns.map((c) => quoteIdent(d, c)).join(', ')})${overriding} VALUES `
    const chunk = BaseAdapter.chunkSize(columns.length)
    const it = rows[Symbol.iterator]()
    let first = it.next()
    if (first.done) return { affectedRows: 0 }
    // One transaction for the whole batch (all or nothing); rows are consumed as they come, a chunk at a time.
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      let offset = 0
      while (!first.done) {
        const batch: Cell[][] = []
        while (!first.done && batch.length < chunk) {
          batch.push(first.value)
          first = it.next()
        }
        const params = new Params(d)
        const values = batch
          .map((row) => `(${columns.map((_, j) => params.add(toDbValue(row[j] ?? null))).join(', ')})`)
          .join(', ')
        try {
          const r = firstResult(await conn.query(head + values, params.values))
          affected += r.affectedRows
        } catch (err) {
          const e = err instanceof AdapterError ? err : this.toAdapterError(err)
          // MySQL names the failing row of the statement; PostgreSQL does not — the batch is the best it gets.
          const at = /\bat row (\d+)/i.exec(e.detail ?? e.message)
          throw new AdapterError(e.code, e.message, e.detail, {
            ...(e.nativeCode ? { nativeCode: e.nativeCode } : {}),
            ...(e.position ? { position: e.position } : {}),
            rows: at ? [offset + Number(at[1]) - 1, offset + Number(at[1]) - 1] : [offset, offset + batch.length - 1],
          })
        }
        offset += batch.length
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
    const where = this.buildKeyWhere(key, params, await this.keyColumnTypes(ns, table))
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
    const types = await this.keyColumnTypes(ns, table)
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      for (const key of keys) {
        const params = new Params(d)
        const where = this.buildKeyWhere(key, params, types)
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

  private buildKeyWhere(key: RowKey, params: Params, types: Map<string, string>): string {
    const d = this.dialect
    const value = (name: string, cell: Cell | undefined) =>
      this.keyParam(params.add(toDbValue(cell ?? null)), types.get(name) ?? '')
    switch (key.kind) {
      case 'pk': {
        const names = Object.keys(key.values)
        if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Primary key values are empty')
        return ` WHERE ${names.map((n) => `${quoteIdent(d, n)} = ${value(n, key.values[n])}`).join(' AND ')}`
      }
      case 'all-columns': {
        if (d !== 'mysql') throw new AdapterError('UNSUPPORTED', 'all-columns keys are only supported on MySQL')
        const names = Object.keys(key.values)
        if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Key values are empty')
        const eq = this.nullSafeEq()
        return ` WHERE ${names.map((n) => `${quoteIdent(d, n)} ${eq} ${value(n, key.values[n])}`).join(' AND ')}`
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
   * one unordered SELECT streamed from the driver in batches (no total order exists to page over). Keyset
   * paging keeps each batch O(batch) instead of OFFSET's O(offset + batch) rescans on large tables.
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
    // Position of each key column in the selected row (ctid is appended as an extra trailing column).
    const keyIndexes =
      key.keyKind === 'pk' ? key.keyColumns.map((c) => schema.columns.findIndex((col) => col.name === c)) : []
    if (keyIndexes.includes(-1)) throw new AdapterError('QUERY_FAILED', 'Key column missing from table schema')
    const keyTypes = keyIndexes.map((i) => schema.columns[i]?.dataType ?? '')
    // The fallback key is selected as `ctid::text AS "ctid"`; an unqualified ORDER BY ctid would bind to that
    // text output column (sorting '(0,10)' before '(0,2)') and disagree with the tid comparison in WHERE.
    const keyExprs =
      key.keyKind === 'pk'
        ? key.keyColumns.map((c, i) => this.keyColumnExpr(quoteIdent(d, c), keyTypes[i] ?? ''))
        : byCtid
          ? [`${tableSql}.ctid`]
          : []
    const selectList = byCtid && fallback ? [...columns, fallback] : columns
    const orderBy = keyExprs.length > 0 ? ` ORDER BY ${keyExprs.join(', ')}` : ''
    const single = orderBy === ''
    const batchSize = Math.max(1, Math.floor(opts.batchSize))
    // Generators cannot run inside withConn's callback, so the borrow/done pair is shared instead
    // (no statement timeout: full scans may legitimately be long).
    const { conn, done } = await this.borrow(ns, 0)
    try {
      if (single && conn.stream) {
        // Streamed rows arrive one at a time, so a key-less table of any size costs one batch of memory.
        const sql = `SELECT ${selectList.join(', ')} FROM ${tableSql}`
        for await (const r of conn.stream(sql, [], batchSize, UNCAPPED)) yield { columns: r.columns, rows: r.rows }
        return
      }
      let last: Cell[] | null = null
      let first = true
      for (;;) {
        const params = new Params(d)
        let where = ''
        if (last) {
          if (byCtid) where = ` WHERE ${tableSql}.ctid > ${params.add(last[last.length - 1])}::tid`
          else {
            const lastRow = last
            const lastKey = keyIndexes.map((i, k) =>
              this.keyParam(params.add(toDbValue(lastRow[i] ?? null)), keyTypes[k] ?? '')
            )
            where = ` WHERE (${keyExprs.join(', ')}) > (${lastKey.join(', ')})`
          }
        }
        const limit = single ? '' : ` LIMIT ${params.add(batchSize)}`
        // Exports must carry whole binaries; the display cap only applies to browsing.
        const r = firstResult(
          await conn.query(
            `SELECT ${selectList.join(', ')} FROM ${tableSql}${where}${orderBy}${limit}`,
            params.values,
            UNCAPPED
          )
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
      inFlight: false,
      cancelling: null,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve
      }),
    }
    if (opts.queryId) this.running.set(opts.queryId, entry)
    try {
      await this.withConn(
        ns,
        async (conn) => {
          try {
            // User SQL may SET the session timeout / namespace itself; never trust the cached values afterwards.
            this.forgetSessionState(conn)
            let capped = await this.capResultRows(conn, opts.maxRows)
            // Published only now: a cancel must interrupt the user's first statement, not the session setup.
            if (opts.queryId) resolveBackend(await this.backendId(conn))
            for (const [statement, st] of statements.entries()) {
              if (entry.cancelled) {
                entry.interrupted = true
                break
              }
              const started = performance.now()
              try {
                entry.inFlight = true
                let list: RawResult[]
                const code = stripLiterals(st.sql, this.dialect)
                const copy =
                  this.dialect === 'postgres' ? COPY_BLOCK.exec(stripLeadingComments(st.sql, 'postgres')) : null
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
                // A script that changed the cap itself (SET SESSION sql_select_limit …) gets it re-applied.
                if (capped && TOUCHES_CAP.test(code)) capped = await this.capResultRows(conn, opts.maxRows)
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
                    })
                  }
                }
              } catch (err) {
                const e = err instanceof AdapterError ? err : this.toAdapterError(err)
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
    const wrapped = wrapMaxRows === null ? null : wrapReadOnly(sql, wrapMaxRows + 1, this.dialect)
    if (!wrapped) return asList(await conn.query(sql, undefined, DISPLAY))
    try {
      return asList(await conn.query(wrapped, undefined, DISPLAY))
    } catch (err) {
      const e = err instanceof AdapterError ? err : this.toAdapterError(err)
      // Statements the wrapper itself breaks (MySQL: duplicate column names, top-level-only modifiers) are
      // re-run as written — never after an interruption, which would restart the cancelled statement.
      if (e.nativeCode !== undefined && this.wrapperOnlyErrors().has(e.nativeCode) && !cancelled()) {
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
    const canceller = await this.openCanceller(entry.ns)
    try {
      // Checked with the connection in hand: the target may have ended while it was being opened.
      if (!stillRunning()) return entry.interrupted
      try {
        await canceller.cancel(backend)
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
        await canceller.cancel(backend).catch(() => undefined)
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
      return settled ? entry.interrupted : true
    } finally {
      await canceller.close()
    }
  }

  /** Maps a driver error to AdapterError. */
  abstract toAdapterError(err: unknown): AdapterError
}
