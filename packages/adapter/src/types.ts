import type {
  ApiErrorCode,
  BrowseOptions,
  BrowseResult,
  Cell,
  ColumnMeta,
  DdlOp,
  Dialect,
  Namespace,
  RowKey,
  RowValues,
  StatementResult,
  TableInfo,
  TableSchema,
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
}

export type AdapterErrorCode = Extract<
  ApiErrorCode,
  'CONNECTION_FAILED' | 'AUTH_FAILED' | 'NOT_FOUND' | 'QUERY_FAILED' | 'KEY_MISMATCH' | 'UNSUPPORTED'
>

export class AdapterError extends Error {
  readonly code: AdapterErrorCode
  readonly detail: string | undefined
  constructor(code: AdapterErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.detail = detail
  }
}

/** Builds dialect-specific DDL. Returns SQL strings only; execution goes through executeSql after user preview. */
export interface DdlBuilder {
  build(ns: Namespace, op: DdlOp): string[]
}

export interface RowBatch {
  columns: ColumnMeta[]
  rows: Cell[][]
}

/** Renders dialect-specific SQL for dumps (INSERT statements with properly escaped literals). */
export interface SqlExporter {
  /** One multi-row INSERT for `rows` (empty string when rows is empty). Includes the trailing semicolon. */
  insert(ns: Namespace, table: string, columns: string[], rows: Cell[][]): string
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
  browseRows(ns: Namespace, table: string, opts: BrowseOptions): Promise<BrowseResult>
  insertRow(ns: Namespace, table: string, values: RowValues): Promise<{ affectedRows: number }>
  /** Bulk insert (imports): parameterised multi-row INSERTs inside one transaction; all-or-nothing. */
  insertRows(ns: Namespace, table: string, columns: string[], rows: Cell[][]): Promise<{ affectedRows: number }>
  updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }>
  deleteRows(ns: Namespace, table: string, keys: RowKey[]): Promise<{ affectedRows: number }>
  executeSql(ns: Namespace, sql: string, opts: ExecuteOptions): Promise<StatementResult[]>
  /** DDL statements that recreate the table (MySQL: SHOW CREATE TABLE; PostgreSQL: reconstructed from the catalog). */
  showCreateTable(ns: Namespace, table: string): Promise<string[]>
  /** Reads every row in stable order, `batchSize` rows at a time (for exports). */
  iterateRows(ns: Namespace, table: string, opts: { batchSize: number }): AsyncIterable<RowBatch>
  readonly ddl: DdlBuilder
  readonly exporter: SqlExporter
}

export type { Cell }

/** Names of every DatabaseAdapter method. Used by spec-consistency tests to detect untested methods. */
export const ADAPTER_METHOD_NAMES = [
  'ping',
  'close',
  'listDatabases',
  'listSchemas',
  'listTables',
  'describeTable',
  'browseRows',
  'insertRow',
  'insertRows',
  'updateRow',
  'deleteRows',
  'executeSql',
  'showCreateTable',
  'iterateRows',
] as const satisfies readonly (keyof DatabaseAdapter)[]
