import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  ColumnMeta,
  DatabaseGrant,
  DatabaseInfo,
  DiagnosticKind,
  DiagnosticQuery,
  DiagnosticReport,
  Dialect,
  DistinctValues,
  EventDetail,
  EventInfo,
  Filter,
  InputCell,
  InsertPreview,
  KeyValue,
  Namespace,
  ObjectDependency,
  Partitioning,
  ProcessInfo,
  ProfileStage,
  QueryBuilderCondition,
  QueryBuilderJoin,
  QueryBuilderResult,
  QueryBuilderSpec,
  ReferenceCheck,
  RelationDef,
  ReplicationInfo,
  RoutineDetail,
  RoutineInfo,
  RoutineKind,
  RowKey,
  RowKeyKind,
  RowValues,
  SearchOptions,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
  StatementResult,
  TableInfo,
  TableSchema,
  TableSearchResult,
  TableStats,
  TriggerDetail,
  TriggerInfo,
  UserInfo,
  UserRef,
  WriteCell,
} from '@tsmyadmin/shared'
import {
  BROWSE_ALL_MAX,
  DISTINCT_VALUES_LIMIT,
  EXACT_COUNT_MAX_ROWS,
  isBinaryCell,
  isFunctionCell,
  isTruncatedCell,
  isViewKind,
  LIST_OPS,
  MAX_TEXT_CHARS,
} from '@tsmyadmin/shared'
import { mysqlLiteral, pgLiteral } from './sql/literal.ts'
import { Params, quoteIdent, quoteTable } from './sql/quote.ts'
import { rowFunctionSql } from './sql/row-functions.ts'
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
/** The largest single value readCell hands over (a download, held in memory while it is sent). */
export const READ_CELL_MAX_BYTES = 64 * 1024 * 1024

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

/** Operators that match on the text form, where a BIT column is not written as its bytes. */
const TEXT_OPS: ReadonlySet<Filter['op']> = new Set([
  'contains',
  'starts_with',
  'like',
  'not_like',
  'regexp',
  'not_regexp',
])

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
  in: 'IN',
  not_in: 'NOT IN',
  between: 'BETWEEN',
  not_between: 'NOT BETWEEN',
  regexp: 'REGEXP',
  not_regexp: 'NOT REGEXP',
  empty: '=',
  not_empty: '<>',
}

/**
 * Column types the database-wide search skips, per dialect, matched on the type name as the catalog prints it.
 *
 * MySQL: binary strings, BIT and the spatial types store bytes, so their text form is raw WKB or binary and a
 * match would be noise (CAST to CHAR accepts them; it just compares bytes). GEOMETRYCOLLECTION is printed as
 * `geomcollection` since 8.0; VECTOR is binary too.
 * PostgreSQL: bytea (and arrays of it), and PostGIS geometry / geography / raster, whose text form is hex EWKB —
 * a short term like "01" would match every row. The built-in bit, point, polygon and the like have a readable
 * `::text` form ("1010", "(1.5,2)") that is worth searching.
 */
const UNSEARCHABLE_TYPE: Record<Dialect, RegExp> = {
  mysql:
    /^(tiny|medium|long)?blob\b|^(var)?binary\b|^bit\b|^vector\b|^(multi)?(point|linestring|polygon)\b|^geometry\b|^geometrycollection\b|^geomcollection\b/i,
  // PostGIS types may be schema-qualified: format_type adds the schema when it is not on the search path, which
  // is the usual case (PostGIS in public or its own schema, browsing another).
  // The whole name has to be the type (optionally with a typmod and array brackets), so a readable type that only
  // starts with one of these words, or sits in a schema named after one, is still searched.
  postgres: /^bytea(?:\[\])*$|(?:^|\.)"?(?:geometry|geography|raster)"?(?:\(.*\))?(?:\[\])*$/i,
}

/** Whether the database-wide search looks at a column of this type (see UNSEARCHABLE_TYPE). */
export function isSearchableType(dialect: Dialect, dataType: string): boolean {
  return !UNSEARCHABLE_TYPE[dialect].test(dataType)
}

/**
 * Escapes LIKE metacharacters so a user string matches literally. `!` is the escape character (declared with
 * ESCAPE '!'): unlike a backslash it needs no dialect-specific string escaping of its own.
 */
/**
 * LEFT JOINs that bring every table after the first into the query, each along a foreign key to a table already
 * joined (either direction). Keys into another database or schema do not count. A table no key reaches is
 * refused rather than cross-joined: a product of two tables is almost never what was meant, and the SQL tab is
 * there for queries that need it.
 */
export function joinPlan(
  d: Dialect,
  ns: Namespace,
  tables: string[],
  schemas: Map<string, TableSchema>,
  explicit: readonly QueryBuilderJoin[] = []
): string[] {
  const home = (other: Namespace) =>
    other.database === ns.database && (d === 'mysql' || (other.schema ?? 'public') === (ns.schema ?? 'public'))
  const col = (table: string, column: string) => `${quoteIdent(d, table)}.${quoteIdent(d, column)}`
  // Every table is described, so their own foreign keys already hold every link between them.
  const links = tables.flatMap((from) =>
    (schemas.get(from)?.foreignKeys ?? [])
      .filter((fk) => home(fk.refNamespace) && fk.refTable !== from)
      .map((fk) => ({ from, to: fk.refTable, fk }))
  )
  const joined = new Set(tables.slice(0, 1))
  const out: string[] = []
  // Joins spelled out come first, in the order of the tables; each may use only tables already joined.
  const has = (r: { table: string; column: string }) =>
    schemas.get(r.table)?.columns.some((c) => c.name === r.column) === true
  for (const table of tables.slice(1)) {
    const j = explicit.find((x) => x.table === table)
    if (!j) continue
    for (const p of j.on) {
      if (!has(p.from) || !has(p.to)) throw new AdapterError('NOT_FOUND', `Unknown column in the join of ${table}`)
      const other = p.from.table === table ? p.to.table : p.from.table
      if (!(p.from.table === table || p.to.table === table) || !(joined.has(other) || other === table))
        throw new AdapterError('VALIDATION', `The join of ${table} must use ${table} and a table joined before it`)
    }
    const on = j.on.map((p) => `${col(p.from.table, p.from.column)} = ${col(p.to.table, p.to.column)}`).join(' AND ')
    out.push(`${j.kind.toUpperCase()} JOIN ${quoteTable(d, ns, table)} ON ${on}`)
    joined.add(table)
  }
  // Repeated passes in the order given, so a table reachable only through a later one still joins, and the same
  // request always gives the same SQL.
  for (let progress = true; progress; ) {
    progress = false
    for (const table of tables) {
      if (joined.has(table)) continue
      const link = links.find((l) => (l.from === table && joined.has(l.to)) || (l.to === table && joined.has(l.from)))
      if (!link) continue
      const on = link.fk.columns
        .map((c, i) => `${col(link.to, link.fk.refColumns[i] ?? '')} = ${col(link.from, c)}`)
        .join(' AND ')
      out.push(`LEFT JOIN ${quoteTable(d, ns, table)} ON ${on}`)
      joined.add(table)
      progress = true
    }
  }
  const unreached = tables.filter((t) => !joined.has(t))
  if (unreached.length > 0)
    throw new AdapterError('VALIDATION', `No foreign key connects ${unreached.join(', ')} to ${tables[0]}`)
  return out
}

const BIT_MAX = 2n ** 64n - 1n

/** A MySQL BIT value typed as a whole number, as the hex literal of its bytes (170 → X'AA'). */
function bitLiteral(value: InputCell): string {
  const text = String(value).trim()
  // BIT holds at most 64 bits; a larger number would be clamped to the maximum by MySQL's CONV, not refused.
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > BIT_MAX)
    throw new AdapterError('VALIDATION', 'A BIT value must be a whole number from 0 to 18446744073709551615')
  const hex = BigInt(text).toString(16)
  return `X'${hex.length % 2 === 0 ? hex : `0${hex}`}'`
}

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
/** MySQL's error number for a duplicate key. */
const DUPLICATE_ENTRY = 1062
/** Warnings an insert reports back at most (a file with a thousand bad values must not return a thousand lines). */
const MAX_INSERT_WARNINGS = 20

export abstract class BaseAdapter implements DatabaseAdapter {
  abstract readonly dialect: Dialect
  abstract readonly ddl: DdlBuilder
  abstract readonly exporter: SqlExporter
  abstract readonly users: UserSqlBuilder

  abstract ping(): Promise<void>
  abstract close(): Promise<void>
  abstract listDatabases(options?: { stats?: boolean }): Promise<DatabaseInfo[]>
  abstract listSchemas(database: string): Promise<string[]>
  abstract listTables(ns: Namespace): Promise<TableInfo[]>
  abstract listForeignKeys(ns: Namespace): Promise<RelationDef[]>
  abstract describeTable(ns: Namespace, table: string): Promise<TableSchema>
  abstract tableStats(ns: Namespace, table: string): Promise<TableStats>
  abstract databaseGrants(database: string): Promise<DatabaseGrant[]>
  abstract listPartitions(ns: Namespace, table: string): Promise<Partitioning>
  abstract listRoutines(ns: Namespace): Promise<RoutineInfo[]>
  abstract routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null>
  abstract routineDetail(
    ns: Namespace,
    name: string,
    kind: RoutineKind,
    parameters?: string
  ): Promise<RoutineDetail | null>
  abstract triggerDetail(ns: Namespace, table: string, name: string): Promise<TriggerDetail | null>
  abstract eventDetail(ns: Namespace, name: string): Promise<EventDetail | null>
  abstract listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]>
  abstract listEvents(ns: Namespace): Promise<EventInfo[]>
  abstract listDependencies(ns: Namespace): Promise<ObjectDependency[] | null>
  abstract readonly serverNamespace: Namespace
  abstract showCreateTable(ns: Namespace, table: string, schema?: TableSchema): Promise<string[]>
  abstract serverInfo(): Promise<ServerInfo>
  abstract listVariables(): Promise<KeyValue[]>
  abstract serverCatalog(kind: ServerCatalogKind): Promise<ServerCatalog>
  abstract replicationInfo(): Promise<ReplicationInfo>
  abstract diagnostics(kind: DiagnosticKind, query?: DiagnosticQuery): Promise<DiagnosticReport>
  abstract listStatus(): Promise<KeyValue[]>
  abstract listProcesses(): Promise<ProcessInfo[]>
  abstract killProcess(id: string): Promise<void>
  abstract listUsers(): Promise<UserInfo[]>
  abstract showGrants(user: UserRef, ns?: Namespace): Promise<string[]>
  abstract canManageAccount(name: string): Promise<boolean>

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
  /** Turns on per-statement profiling for this run; false where the server has none. Reset with the session. */
  protected async startProfiling(_conn: Conn): Promise<boolean> {
    return false
  }
  /** The stages of the statement just run, when profiling is on. */
  protected async readProfile(_conn: Conn): Promise<ProfileStage[] | null> {
    return null
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
  /**
   * Both sides of an all-columns key comparison, wrapped so the match is exact rather than collation-equal.
   * The default is no wrapping (PostgreSQL addresses rows by ctid and never takes this path).
   */
  protected keyMatchExpr(expr: string, _type: string): string {
    return expr
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

  async checkReferences(ns: Namespace, table: string): Promise<ReferenceCheck[]> {
    const schema = await this.describeTable(ns, table)
    const d = this.dialect
    return this.withConn(ns, async (conn) => {
      const out: ReferenceCheck[] = []
      for (const fk of schema.foreignKeys) {
        const child = quoteTable(d, ns, table)
        const parent = quoteTable(d, fk.refNamespace, fk.refTable)
        const on = fk.columns
          .map((c, i) => `c.${quoteIdent(d, c)} = p.${quoteIdent(d, fk.refColumns[i] ?? '')}`)
          .join(' AND ')
        // A key with a NULL in it names no parent (MATCH SIMPLE): only rows with every column set are checked.
        const where = [
          `p.${quoteIdent(d, fk.refColumns[0] ?? '')} IS NULL`,
          ...fk.columns.map((c) => `c.${quoteIdent(d, c)} IS NOT NULL`),
        ].join(' AND ')
        const from = `FROM ${child} c LEFT JOIN ${parent} p ON ${on} WHERE ${where}`
        const count = firstResult(await conn.query(`SELECT COUNT(*) ${from}`)).rows[0]?.[0]
        out.push({
          name: fk.name,
          columns: fk.columns,
          refNamespace: fk.refNamespace,
          refTable: fk.refTable,
          refColumns: fk.refColumns,
          orphans: Number(count ?? 0),
          sql: `SELECT c.* ${from}`,
        })
      }
      return out
    })
  }

  async distinctValues(ns: Namespace, table: string, column: string): Promise<DistinctValues> {
    const schema = await this.describeTable(ns, table)
    if (!schema.columns.some((c) => c.name === column)) throw new AdapterError('NOT_FOUND', `Unknown column: ${column}`)
    const d = this.dialect
    const col = quoteIdent(d, column)
    const params = new Params(d)
    const sql = `SELECT ${col}, COUNT(*) AS n FROM ${quoteTable(d, ns, table)} GROUP BY ${col} ORDER BY n DESC, ${col} LIMIT ${params.add(DISTINCT_VALUES_LIMIT + 1)}`
    return this.withConn(ns, async (conn) => {
      const rows = firstResult(await conn.query(sql, params.values)).rows
      return {
        values: rows.slice(0, DISTINCT_VALUES_LIMIT).map((r) => ({ value: r[0] ?? null, count: Number(r[1]) })),
        truncated: rows.length > DISTINCT_VALUES_LIMIT,
      }
    })
  }

  async searchTable(
    ns: Namespace,
    table: string,
    term: string,
    options: SearchOptions = {}
  ): Promise<TableSearchResult> {
    const schema = await this.describeTable(ns, table)
    const d = this.dialect
    const mode = options.mode ?? 'phrase'
    const only = options.column?.trim().toLowerCase()
    // Columns whose values have no readable text form are skipped (see UNSEARCHABLE_TYPE).
    const columns = schema.columns
      .filter((c) => isSearchableType(d, c.dataType) && (!only || c.name.toLowerCase().includes(only)))
      .map((c) => c.name)
    if (columns.length === 0) return { total: 0, count: 'exact', columns: [], sql: '', deleteSql: '' }
    const tableSql = quoteTable(d, ns, table)
    // Same meaning of "contains" as the browse filter: the term is literal, wildcards added here. Case-insensitive
    // on both servers — MySQL through the connection's collation, PostgreSQL with ILIKE / ~* — as phpMyAdmin
    // searches. A regular expression is the server's own.
    const words = mode === 'any' || mode === 'all' ? term.split(/\s+/).filter((w) => w !== '') : [term]
    const text = (c: string) => (d === 'mysql' ? `CAST(${quoteIdent(d, c)} AS CHAR)` : `${quoteIdent(d, c)}::text`)
    const match = (bind: (v: string) => string) => {
      const one = (c: string, w: string) =>
        mode === 'regexp'
          ? `${text(c)} ${d === 'mysql' ? 'REGEXP' : '~*'} ${bind(w)}`
          : `${text(c)} ${d === 'mysql' ? 'LIKE' : 'ILIKE'} ${bind(`%${escapeLike(w)}%`)} ESCAPE '!'`
      // A word matches the row when any column holds it; "all" needs every word, the others any.
      const perWord = words.map((w) => `(${columns.map((c) => one(c, w)).join(' OR ')})`)
      return perWord.join(mode === 'all' ? ' AND ' : ' OR ')
    }
    const params = new Params(d)
    const where = match((v) => params.add(v))
    // Bounded like the browse count: a term that matches most of a huge table is still one limited scan.
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${tableSql} WHERE ${where} LIMIT ${params.add(EXACT_COUNT_MAX_ROWS + 1)}) AS tsmyadmin_search`
    // For the SQL tab, where it is edited and run: the term is written in as a literal there.
    const literalWhere = match((v) => (d === 'mysql' ? mysqlLiteral(v) : pgLiteral(v)))
    const sql = `SELECT * FROM ${tableSql} WHERE ${literalWhere}`
    const deleteSql = `DELETE FROM ${tableSql} WHERE ${literalWhere}`
    return this.withConn(ns, async (conn) => {
      const cell = firstResult(await conn.query(countSql, params.values)).rows[0]?.[0]
      const counted = typeof cell === 'number' ? cell : Number(cell ?? 0)
      const bounded = counted > EXACT_COUNT_MAX_ROWS
      return {
        total: bounded ? EXACT_COUNT_MAX_ROWS : counted,
        count: bounded ? 'lower_bound' : 'exact',
        columns,
        sql,
        deleteSql,
      }
    })
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
    const types = new Map(schema.columns.map((c) => [c.name, c.dataType]))
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
    // Built twice from the same pieces: with placeholders (what runs) and with the values written in (what is shown
    // to edit, explain or save).
    const build = (p: Params) =>
      `SELECT ${selectList.join(', ')} FROM ${tableSql}${this.buildWhere(opts.filters, p, types)}${order} LIMIT ${p.add(opts.limit === 0 ? BROWSE_ALL_MAX : opts.limit)} OFFSET ${p.add(opts.limit === 0 ? 0 : opts.offset)}`
    const params = new Params(d)
    const dataSql = build(params)
    const literalSql = build(new Params(d, true))

    // The count stops at the threshold: a filter matching millions of rows costs one bounded scan, and the page
    // then says "100,000+" instead of the exact figure.
    const countParams = new Params(d)
    const countWhere = this.buildWhere(opts.filters, countParams, types)
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${tableSql}${countWhere} LIMIT ${countParams.add(EXACT_COUNT_MAX_ROWS + 1)}) AS tsmyadmin_count`

    return this.withConn(ns, async (conn) => {
      const profiling = opts.profile ? await this.startProfiling(conn) : false
      const started = performance.now()
      const data = firstResult(await conn.query(dataSql, params.values, DISPLAY))
      const duration = performance.now() - started
      // Read before anything else runs: the profile is of the most recent statement.
      const stages = profiling ? await this.readProfile(conn).catch(() => null) : null
      const statement = {
        sql: dataSql,
        literal: literalSql,
        ...(stages && stages.length > 0 ? { profile: stages } : {}),
        // Bound values go back as cells: a binary filter was turned into a Buffer for the driver.
        params: params.values.map((v) => (v instanceof Uint8Array ? bufferToCell(v) : (v as Cell))),
        durationMs: duration,
      }
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
          statement,
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
        statement,
      }
    })
  }

  private buildWhere(filters: Filter[], params: Params, types: Map<string, string>): string {
    if (filters.length === 0) return ''
    const parts = filters.map((f) =>
      this.conditionSql(quoteIdent(this.dialect, f.column), f, types.get(f.column) ?? '', (v) =>
        params.add(toDbValue(v))
      )
    )
    return ` WHERE ${parts.join(' AND ')}`
  }

  /**
   * One condition on one column, shared by the browse filter and the query builder. `bind` turns a value into
   * SQL text: a placeholder for browsing, a quoted literal for a statement the user will edit in the SQL tab.
   */
  private conditionSql(
    col: string,
    f: Pick<Filter, 'column' | 'op' | 'value' | 'values'>,
    type: string,
    bind: (value: InputCell) => string
  ): string {
    const d = this.dialect
    const op = FILTER_SQL[f.op]
    if (f.op === 'is_null' || f.op === 'is_not_null') return `${col} ${op}`
    // The column's text form: PostgreSQL has no implicit cast for LIKE / ~ on numbers, dates or json. On MySQL an
    // INT compared with '' would convert '' to 0; CONCAT gives the text ('0') instead, and keeps NULL as NULL.
    const textCol = d === 'postgres' ? `${col}::text` : col
    if (f.op === 'empty' || f.op === 'not_empty') return `${d === 'mysql' ? `CONCAT(${col})` : textCol} ${op} ''`
    if (LIST_OPS.has(f.op)) {
      const values = f.values ?? []
      const between = f.op === 'between' || f.op === 'not_between'
      if (between ? values.length !== 2 : values.length === 0)
        throw new AdapterError(
          'VALIDATION',
          `Filter "${f.op}" on ${f.column} takes ${between ? 'two values' : 'at least one value'}`
        )
      const typed = values.map((v) => this.keyParam(bind(v), type))
      return between ? `${col} ${op} ${typed[0]} AND ${typed[1]}` : `${col} ${op} (${typed.join(', ')})`
    }
    if (f.value === undefined)
      throw new AdapterError('QUERY_FAILED', `Filter "${f.op}" on ${f.column} requires a value`)
    if (f.op === 'contains' || f.op === 'starts_with') {
      // The user's text is matched literally: LIKE metacharacters are escaped, wildcards added here.
      const text = escapeLike(String(f.value ?? ''))
      const pattern = f.op === 'contains' ? `%${text}%` : `${text}%`
      return `${textCol} LIKE ${bind(pattern)} ESCAPE '!'`
    }
    if (f.op === 'like' || f.op === 'not_like') return `${textCol} ${op} ${bind(f.value)}`
    if (f.op === 'regexp' || f.op === 'not_regexp')
      return d === 'postgres'
        ? `${textCol} ${f.op === 'regexp' ? '~' : '!~'} ${bind(f.value)}`
        : `${col} ${op} ${bind(f.value)}`
    // Comparisons use the column's own type (FLOAT 0.1 is not the DOUBLE literal 0.1; BIT is not a hex string).
    return `${col} ${op} ${this.keyParam(bind(f.value), type)}`
  }

  async buildQuery(ns: Namespace, spec: QueryBuilderSpec): Promise<QueryBuilderResult> {
    const d = this.dialect
    if (new Set(spec.tables).size !== spec.tables.length)
      throw new AdapterError('VALIDATION', 'Each table can be listed only once')
    const schemas = new Map<string, TableSchema>()
    // One at a time: the session's pool is small, and structure reads are quick.
    for (const table of spec.tables) schemas.set(table, await this.describeTable(ns, table))
    const typeOf = (ref: { table: string; column: string }): string => {
      const column = schemas.get(ref.table)?.columns.find((c) => c.name === ref.column)
      if (!column) throw new AdapterError('NOT_FOUND', `Unknown column: ${ref.table}.${ref.column}`)
      return column.dataType
    }
    // Columns are qualified by the bare table name, which FROM leaves in scope in both dialects.
    const ref = (r: { table: string; column: string }) => `${quoteIdent(d, r.table)}.${quoteIdent(d, r.column)}`
    const literal = (v: InputCell) => (d === 'mysql' ? mysqlLiteral(String(v)) : pgLiteral(String(v)))

    const select = spec.columns
      .filter((c) => c.show)
      .map((c) => {
        typeOf(c)
        return c.alias === '' ? ref(c) : `${ref(c)} AS ${quoteIdent(d, c.alias)}`
      })
    const condition = (c: QueryBuilderCondition) => {
      const type = typeOf(c)
      // MySQL compares BIT through the bytes bound for it (see keyParam): a quoted '170' would be read as the
      // bytes of the text "170". The number is written as those bytes instead.
      const bitCompare = d === 'mysql' && /^bit\b/i.test(type) && !TEXT_OPS.has(c.op)
      return this.conditionSql(ref(c), c, type, bitCompare ? bitLiteral : literal)
    }
    const groups = spec.where.map((g) => g.map(condition).join(' AND '))
    const order = spec.columns
      .filter((c) => c.sort !== null)
      .map((c) => {
        typeOf(c)
        return `${ref(c)} ${c.sort === 'desc' ? 'DESC' : 'ASC'}`
      })

    const lines = [
      `SELECT ${spec.distinct ? 'DISTINCT ' : ''}${select.length === 0 ? '*' : select.join(', ')}`,
      `FROM ${quoteTable(d, ns, spec.tables[0] ?? '')}`,
      ...joinPlan(d, ns, spec.tables, schemas, spec.joins),
    ]
    const typed = (spec.whereSql ?? '').trim()
    const built = groups.length === 1 ? groups[0] : groups.length > 1 ? groups.map((g) => `(${g})`).join(' OR ') : ''
    // Typed SQL goes in its own parentheses, so an OR in it cannot escape the AND with the built conditions.
    const where = [built && typed && groups.length > 1 ? `(${built})` : built, typed && `(${typed})`].filter(Boolean)
    if (where.length > 0) lines.push(`WHERE ${where.join(' AND ')}`)
    if (order.length > 0) lines.push(`ORDER BY ${order.join(', ')}`)
    if (spec.limit != null) lines.push(`LIMIT ${spec.limit}`)
    return { sql: lines.join('\n') }
  }

  /** A value to write: bound as a parameter, or an allowed function around its bound argument. */
  private writeValue(params: Params, cell: WriteCell): string {
    if (!isFunctionCell(cell)) return params.add(toDbValue(cell))
    return rowFunctionSql(this.dialect, cell.$fn, () => params.add(cell.arg ?? null))
  }

  private insertStatement(
    ns: Namespace,
    table: string,
    values: RowValues,
    ignore: boolean
  ): { sql: string; params: unknown[] } {
    const d = this.dialect
    const names = Object.keys(values)
    const params = new Params(d)
    const verb = d === 'mysql' && ignore ? 'INSERT IGNORE' : 'INSERT'
    const head =
      names.length === 0
        ? d === 'mysql'
          ? `${verb} INTO ${quoteTable(d, ns, table)} () VALUES ()`
          : `${verb} INTO ${quoteTable(d, ns, table)} DEFAULT VALUES`
        : `${verb} INTO ${quoteTable(d, ns, table)} (${names.map((n) => quoteIdent(d, n)).join(', ')}) VALUES (${names
            .map((n) => this.writeValue(params, values[n] ?? null))
            .join(', ')})`
    return { sql: d === 'postgres' && ignore ? `${head} ON CONFLICT DO NOTHING` : head, params: params.values }
  }

  async insertRow(
    ns: Namespace,
    table: string,
    values: RowValues,
    options: { ignore?: boolean } = {}
  ): Promise<{ affectedRows: number }> {
    const { sql, params } = this.insertStatement(ns, table, values, options.ignore === true)
    return this.withConn(ns, async (conn) => {
      const r = firstResult(await conn.query(sql, params))
      return { affectedRows: r.affectedRows }
    })
  }

  insertPreview(ns: Namespace, table: string, values: RowValues, options: { ignore?: boolean } = {}): InsertPreview {
    const { sql, params } = this.insertStatement(ns, table, values, options.ignore === true)
    // What the driver would be given, as wire cells: bytes as base64, the rest as they are.
    return {
      sql,
      params: params.map((p) => (Buffer.isBuffer(p) ? { $bin: p.toString('base64') } : (p as Cell))),
    }
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
  ): Promise<{ affectedRows: number; warnings?: string[] }> {
    if (columns.length === 0) throw new AdapterError('QUERY_FAILED', 'insertRows requires at least one column')
    const d = this.dialect
    // A PostgreSQL identity column declared ALWAYS refuses explicit values without OVERRIDING SYSTEM VALUE.
    const overriding = d === 'postgres' && options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''
    const mysqlVerb =
      options.onDuplicate === 'replace' ? 'REPLACE' : options.onDuplicate === 'ignore' ? 'INSERT IGNORE' : 'INSERT'
    const verb = d === 'mysql' ? mysqlVerb : 'INSERT'
    const head = `${verb} INTO ${quoteTable(d, ns, table)} (${columns.map((c) => quoteIdent(d, c)).join(', ')})${overriding} VALUES `
    // PostgreSQL has neither: a conflicting row is skipped, or its key's other columns are rewritten.
    const rest = columns.filter((c) => !(options.keyColumns ?? []).includes(c))
    if (d === 'postgres' && options.onDuplicate === 'replace' && (options.keyColumns ?? []).length === 0)
      throw new AdapterError('VALIDATION', 'Replacing rows needs a primary key on the table')
    const tail =
      d !== 'postgres' || !options.onDuplicate
        ? ''
        : options.onDuplicate === 'ignore' || rest.length === 0
          ? ' ON CONFLICT DO NOTHING'
          : ` ON CONFLICT (${(options.keyColumns ?? []).map((c) => quoteIdent(d, c)).join(', ')}) DO UPDATE SET ${rest.map((c) => `${quoteIdent(d, c)} = EXCLUDED.${quoteIdent(d, c)}`).join(', ')}`
    const chunk = BaseAdapter.chunkSize(columns.length)
    const it = rows[Symbol.iterator]()
    let first = it.next()
    if (first.done) return { affectedRows: 0 }
    // One transaction for the whole batch (all or nothing); rows are consumed as they come, a chunk at a time.
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      let offset = 0
      // INSERT IGNORE turns more than a key clash into a warning (a value cut to fit, a bad conversion): what it let
      // pass is read back after each statement and handed to the caller, which says so rather than saying nothing.
      const warnings: string[] = []
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
          const r = firstResult(await conn.query(head + values + tail, params.values))
          affected += r.affectedRows
          if (d === 'mysql' && options.onDuplicate === 'ignore') {
            for (const w of firstResult(await conn.query('SHOW WARNINGS')).rows) {
              // 1062 is the duplicate key itself, which is what was asked to be left out.
              if (Number(w[1]) !== DUPLICATE_ENTRY && warnings.length < MAX_INSERT_WARNINGS) warnings.push(String(w[2]))
            }
          }
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
      return { affectedRows: affected, ...(warnings.length > 0 ? { warnings } : {}) }
    })
  }

  async updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }> {
    const d = this.dialect
    const names = Object.keys(values)
    if (names.length === 0) return { affectedRows: 0 }
    const params = new Params(d)
    const set = names.map((n) => `${quoteIdent(d, n)} = ${this.writeValue(params, values[n] ?? null)}`).join(', ')
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

  async countRows(ns: Namespace, table: string): Promise<number> {
    const r = await this.withConn(ns, async (conn) =>
      firstResult(await conn.query(`SELECT COUNT(*) FROM ${quoteTable(this.dialect, ns, table)}`))
    )
    return Number(r.rows[0]?.[0] ?? 0)
  }

  async readCell(ns: Namespace, table: string, key: RowKey, column: string): Promise<Cell> {
    const d = this.dialect
    const schema = await this.describeTable(ns, table)
    const def = schema.columns.find((c) => c.name === column)
    if (!def) throw new AdapterError('NOT_FOUND', `Unknown column: ${column}`)
    const params = new Params(d)
    const where = this.buildKeyWhere(key, params, await this.keyColumnTypes(ns, table))
    const col = quoteIdent(d, column)
    // PostgreSQL's octet_length takes only text, bytea and bit: any other type is measured by its text form.
    const measured =
      d === 'postgres' && !/^(bytea|bit|text|character|varchar)\b/i.test(def.dataType) ? `${col}::text` : col
    // The size first, so a value too large to hand over is refused before it is read into memory.
    const sql = `SELECT OCTET_LENGTH(${measured}) FROM ${quoteTable(d, ns, table)}${where} LIMIT 2`
    return this.withConn(ns, async (conn) => {
      const sized = firstResult(await conn.query(sql, params.values))
      if (sized.rows.length !== 1)
        throw new AdapterError('KEY_MISMATCH', `Expected exactly 1 row but matched ${sized.rows.length}`)
      if (Number(sized.rows[0]?.[0] ?? 0) > READ_CELL_MAX_BYTES)
        throw new AdapterError('VALIDATION', `The value is larger than ${READ_CELL_MAX_BYTES} bytes`)
      const read = firstResult(
        await conn.query(`SELECT ${col} FROM ${quoteTable(d, ns, table)}${where} LIMIT 2`, params.values, UNCAPPED)
      )
      if (read.rows.length !== 1)
        throw new AdapterError('KEY_MISMATCH', `Expected exactly 1 row but matched ${read.rows.length}`)
      return read.rows[0]?.[0] ?? null
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
        // Every column is the key here, so the comparison has to be exact: under the column's own collation
        // rows differing only by case, accent or trailing space are equal, and `LIMIT 1` would then pick
        // whichever the scan reached first — silently editing a row the user did not click.
        const match = (n: string, expr: string) => this.keyMatchExpr(expr, types.get(n) ?? '')
        return ` WHERE ${names
          .map((n) => `${match(n, quoteIdent(d, n))} ${eq} ${match(n, value(n, key.values[n]))}`)
          .join(' AND ')}`
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
    opts: { batchSize: number; schema?: TableSchema; utc?: boolean }
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
      // Times as UTC, for a dump restored under a session that reads them as UTC (the pool resets the session after).
      if (opts.utc) await conn.query("SET SESSION time_zone = '+00:00'")
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
    const statements = opts.statements ?? splitStatements(script, this.dialect)
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
      await this.withConn(
        ns,
        async (conn) => {
          try {
            // User SQL may SET the session timeout / namespace itself; never trust the cached values afterwards.
            this.forgetSessionState(conn)
            let capped = await this.capResultRows(conn, opts.maxRows)
            const profiling = opts.profile ? await this.startProfiling(conn) : false
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
                // Read before anything else runs: the profile is of the most recent statement.
                const stages = profiling ? await this.readProfile(conn).catch(() => null) : null
                const profile = stages && stages.length > 0 ? { profile: stages } : {}
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
    const canceller = await this.openCanceller(entry.ns)
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

  /** Maps a driver error to AdapterError. */
  abstract toAdapterError(err: unknown): AdapterError
}
