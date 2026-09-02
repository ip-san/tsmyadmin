import type {
  ApiErrorCode,
  BrowseOptions,
  BrowseResult,
  Cell,
  ColumnMeta,
  DdlOp,
  Dialect,
  EventInfo,
  KeyValue,
  Namespace,
  ProcessInfo,
  RoutineInfo,
  RoutineKind,
  RowKey,
  RowValues,
  ServerInfo,
  StatementResult,
  TableInfo,
  TableSchema,
  TriggerInfo,
  UserInfo,
  UserOp,
  UserRef,
} from '@tsmyadmin/shared'

export interface ConnectionConfig {
  dialect: Dialect
  host: string
  port: number
  user: string
  password: string
  /** Initial database. Required for PostgreSQL (defaults to `user` when omitted). */
  database?: string | undefined
}

export interface ExecuteOptions {
  maxRows: number
  timeoutMs: number
  stopOnError: boolean
  /** When set, the run is registered under this id so cancelQuery(id) can interrupt it from another connection. */
  queryId?: string
  /** Called as each statement finishes (before the next starts); lets callers stream results per statement. */
  onResult?: (result: StatementResult, index: number) => void | Promise<void>
}

export type AdapterErrorCode = Extract<
  ApiErrorCode,
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'QUERY_FAILED'
  | 'KEY_MISMATCH'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'VALIDATION'
>

export interface AdapterErrorExtra {
  /** Driver / server error code (MySQL ER_*, PostgreSQL SQLSTATE). */
  nativeCode?: string
  /** 1-based character offset in the statement (PostgreSQL). */
  position?: number
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode
  /** Human-readable server message without the code prefix. */
  readonly detail: string | undefined
  readonly nativeCode: string | undefined
  readonly position: number | undefined
  constructor(code: AdapterErrorCode, message: string, detail?: string, extra: AdapterErrorExtra = {}) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.detail = detail
    this.nativeCode = extra.nativeCode
    this.position = extra.position
  }
}

/** Builds dialect-specific DDL. Returns SQL strings only; execution goes through executeSql after user preview. */
export interface DdlBuilder {
  build(ns: Namespace, op: DdlOp): string[]
}

/** One account-management statement: `sql` is executed, `display` (passwords masked) is what the user sees. */
export interface UserStatement {
  sql: string
  display: string
}

/** Builds account-management SQL. */
export interface UserSqlBuilder {
  build(op: UserOp): UserStatement[]
  /** Namespace the statements must run in (PostgreSQL GRANTs are per database). */
  namespace(op: UserOp, serverNamespace: Namespace): Namespace
}

export interface RowBatch {
  columns: ColumnMeta[]
  rows: Cell[][]
}

/** Renders dialect-specific SQL for dumps (INSERT statements with properly escaped literals). */
export interface SqlExporter {
  /**
   * Statements emitted once at the top / bottom of a SQL dump so it restores the way it was written
   * (MySQL: save + neutralise sql_mode so backslash escapes stay valid, disable FK checks during load).
   */
  preamble(ns: Namespace): string[]
  postamble(): string[]
  /** `DROP TABLE|VIEW IF EXISTS` statement (no trailing semicolon) for a dump that restores over existing objects. */
  dropIfExists(ns: Namespace, schema: TableSchema): string
  /**
   * One multi-row INSERT for `rows` (empty string when rows is empty). Includes the trailing semicolon.
   * `overriding` (PostgreSQL) adds OVERRIDING SYSTEM VALUE so GENERATED ALWAYS AS IDENTITY values are kept.
   */
  insert(ns: Namespace, table: string, columns: string[], rows: Cell[][], options?: { overriding?: boolean }): string
  /** Statements to run after a table's data (PostgreSQL: advance identity/serial sequences past the loaded ids). */
  afterData(ns: Namespace, schema: TableSchema): string[]
  /** SQL literal for a wire cell. */
  literal(cell: Cell): string
}

export interface DatabaseAdapter {
  readonly dialect: Dialect
  ping(): Promise<void>
  close(): Promise<void>
  listDatabases(): Promise<{ name: string }[]>
  /** PostgreSQL schemas inside `database`; MySQL returns []. */
  listSchemas(database: string): Promise<string[]>
  listTables(ns: Namespace): Promise<TableInfo[]>
  describeTable(ns: Namespace, table: string): Promise<TableSchema>
  /** Stored procedures and functions in the namespace (metadata only; see routineDefinition). */
  listRoutines(ns: Namespace): Promise<RoutineInfo[]>
  /** CREATE statement of one routine; null when the account may not read it, NOT_FOUND when it does not exist. */
  routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null>
  /** Triggers in the namespace, optionally only for one table. */
  listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]>
  /** Scheduled events (MySQL). PostgreSQL returns []. */
  listEvents(ns: Namespace): Promise<EventInfo[]>
  browseRows(ns: Namespace, table: string, opts: BrowseOptions): Promise<BrowseResult>
  insertRow(ns: Namespace, table: string, values: RowValues): Promise<{ affectedRows: number }>
  /** Bulk insert (imports): parameterised multi-row INSERTs inside one transaction; all-or-nothing. */
  insertRows(ns: Namespace, table: string, columns: string[], rows: Cell[][]): Promise<{ affectedRows: number }>
  updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }>
  deleteRows(ns: Namespace, table: string, keys: RowKey[]): Promise<{ affectedRows: number }>
  executeSql(ns: Namespace, sql: string, opts: ExecuteOptions): Promise<StatementResult[]>
  /** Interrupts a running executeSql registered with `queryId`. Resolves false when nothing is running under that id. */
  cancelQuery(queryId: string): Promise<boolean>
  /**
   * DDL statements that recreate the table (MySQL: SHOW CREATE TABLE; PostgreSQL: reconstructed from the catalog).
   * Pass an already-fetched `schema` to avoid a second catalog round trip.
   */
  showCreateTable(ns: Namespace, table: string, schema?: TableSchema): Promise<string[]>
  /**
   * Reads every row in stable order, `batchSize` rows at a time (for exports). An empty table yields one
   * batch with `columns` and no rows, so callers always learn the column list.
   */
  iterateRows(ns: Namespace, table: string, opts: { batchSize: number; schema?: TableSchema }): AsyncIterable<RowBatch>
  /** Login accounts (MySQL mysql.user, PostgreSQL pg_roles). Requires read privileges on the catalog. */
  /** Namespace that any account can use for server-level statements (MySQL: information_schema; PostgreSQL: the login database). */
  readonly serverNamespace: Namespace
  serverInfo(): Promise<ServerInfo>
  /** Configuration variables (SHOW GLOBAL VARIABLES / pg_settings). */
  listVariables(): Promise<KeyValue[]>
  /** Runtime counters (SHOW GLOBAL STATUS / pg_stat_*). */
  listStatus(): Promise<KeyValue[]>
  listProcesses(): Promise<ProcessInfo[]>
  /** Terminates a connection (KILL / pg_terminate_backend). `id` must be numeric. */
  killProcess(id: string): Promise<void>
  listUsers(): Promise<UserInfo[]>
  /**
   * Effective grants as SQL statements (MySQL SHOW GRANTS; PostgreSQL reconstructed from the catalog).
   * PostgreSQL privileges are per database: `ns` selects which database's schema/table ACLs are listed
   * (default: the login database). MySQL grants are global and ignore `ns`.
   */
  showGrants(user: UserRef, ns?: Namespace): Promise<string[]>
  readonly ddl: DdlBuilder
  readonly exporter: SqlExporter
  readonly users: UserSqlBuilder
}

export type { Cell }

type AdapterMethodName = {
  [K in keyof DatabaseAdapter]: DatabaseAdapter[K] extends (...args: never[]) => unknown ? K : never
}[keyof DatabaseAdapter]

/**
 * Names of every DatabaseAdapter method. Used by spec-consistency tests to detect untested methods and by the
 * audit wrapper to classify calls. The `Record<AdapterMethodName, true>` check makes a method added to the
 * interface but missing here a compile error (a bare `satisfies` on the array would only reject unknown names).
 */
export const ADAPTER_METHOD_NAMES = [
  'ping',
  'close',
  'listDatabases',
  'listSchemas',
  'listTables',
  'describeTable',
  'listRoutines',
  'routineDefinition',
  'listTriggers',
  'listEvents',
  'browseRows',
  'insertRow',
  'insertRows',
  'updateRow',
  'deleteRows',
  'executeSql',
  'cancelQuery',
  'showCreateTable',
  'iterateRows',
  'listUsers',
  'showGrants',
  'serverInfo',
  'listVariables',
  'listStatus',
  'listProcesses',
  'killProcess',
] as const satisfies readonly AdapterMethodName[]

const _exhaustive: Record<AdapterMethodName, true> = Object.fromEntries(
  ADAPTER_METHOD_NAMES.map((n) => [n, true])
) as Record<(typeof ADAPTER_METHOD_NAMES)[number], true>
void _exhaustive
