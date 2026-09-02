import type {
  DatabaseInfo,
  EventInfo,
  KeyValue,
  Namespace,
  ProcessInfo,
  RoutineInfo,
  RoutineKind,
  ServerInfo,
  TableInfo,
  TableSchema,
  TriggerInfo,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import mysql, {
  type Connection,
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
} from 'mysql2/promise'
import {
  BaseAdapter,
  type Canceller,
  type Conn,
  driverValueToCell,
  firstResult,
  type QueryOptions,
  type RawResult,
} from '../base.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type AdapterErrorCode, type ConnectionConfig } from '../types.ts'
import { mysqlDdl } from './ddl.ts'
import { mysqlExporter } from './export.ts'
import { mysqlDescribeTable, mysqlListTables } from './introspect.ts'
import { mysqlListEvents, mysqlListRoutines, mysqlListTriggers, mysqlRoutineDefinition } from './routines.ts'
import { mysqlKillProcess, mysqlListProcesses, mysqlListStatus, mysqlListVariables, mysqlServerInfo } from './server.ts'
import { mysqlListUsers, mysqlShowGrants, mysqlUsers } from './users.ts'
import { mysqlColumnMeta } from './values.ts'

const AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR'])
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ER_HOST_NOT_PRIVILEGED',
  'ER_HOST_IS_BLOCKED',
])
const NOT_FOUND_CODES = new Set([
  'ER_NO_SUCH_TABLE',
  'ER_BAD_DB_ERROR',
  'ER_BAD_FIELD_ERROR',
  'ER_NO_SUCH_THREAD',
  'ER_SP_DOES_NOT_EXIST',
])
/** The account is authenticated but lacks a privilege for this statement/object. */
const PERMISSION_CODES = new Set([
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_PROCACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_KILL_DENIED_ERROR',
])
/**
 * Killed connections surface as a fatal protocol error. ER_QUERY_INTERRUPTED (KILL QUERY / max_execution_time)
 * is deliberately *not* here: it ends the statement but leaves the connection usable, so it stays QUERY_FAILED.
 */
const KILLED_CODES = new Set(['ER_CONNECTION_KILLED', 'PROTOCOL_CONNECTION_LOST'])
/** Derived-table wrapping (only used for statements with their own LIMIT) fails where the bare statement would not. */
const WRAPPER_ONLY_ERRORS: ReadonlySet<string> = new Set([
  'ER_DUP_FIELDNAME',
  'ER_CANT_USE_OPTION_HERE',
  'ER_PARSE_ERROR',
])
/** MariaDB-only errno values the driver has no symbolic name for; anything else unnamed becomes `ER_<errno>`. */
const MARIADB_ERRNO_NAMES: Record<number, string> = {
  1969: 'ER_STATEMENT_TIMEOUT',
}

type QueryOutput = [unknown, FieldPacket[] | FieldPacket[][] | undefined]

/** Collation negotiated at handshake; SET NAMES after a connection reset must restore the same one. */
const SESSION_COLLATION = 'utf8mb4_unicode_ci'
/**
 * Placeholder values are escaped client-side by the driver with backslashes (mysql2 does not prepare `query()`);
 * a server running with NO_BACKSLASH_ESCAPES would read `\'` as a backslash plus a string terminator, turning any
 * quote in a filter value or row key into a syntax error or a WHERE-clause injection. The flag is removed from
 * the *session* mode (everything else is kept), so DDL literals built by `mysqlLiteral` are safe as well.
 */
const SESSION_SQL_MODE =
  "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))"

function isHeader(v: unknown): v is ResultSetHeader {
  return typeof v === 'object' && v !== null && 'affectedRows' in v
}

function normalise(
  rowsOut: unknown,
  fields: FieldPacket[] | FieldPacket[][] | undefined,
  binaryLimit?: number
): RawResult | RawResult[] {
  if (isHeader(rowsOut)) return { columns: [], rows: [], affectedRows: rowsOut.affectedRows, hasRows: false }
  const rows = rowsOut as unknown[]
  const multi = Array.isArray(fields) && Array.isArray(fields[0])
  if (multi) {
    const sets = fields as FieldPacket[][]
    const out: RawResult[] = []
    for (let i = 0; i < rows.length; i++) {
      const part = rows[i]
      const partFields = sets[i]
      if (isHeader(part) || !partFields) {
        if (isHeader(part)) out.push({ columns: [], rows: [], affectedRows: part.affectedRows, hasRows: false })
        continue
      }
      out.push({
        columns: partFields.map(mysqlColumnMeta),
        rows: (part as unknown[][]).map((r) => r.map((v) => driverValueToCell(v, binaryLimit))),
        affectedRows: 0,
        hasRows: true,
      })
    }
    return out
  }
  const single = (fields ?? []) as FieldPacket[]
  return {
    columns: single.map(mysqlColumnMeta),
    rows: (rows as unknown[][]).map((r) => r.map((v) => driverValueToCell(v, binaryLimit))),
    affectedRows: 0,
    hasRows: true,
  }
}

export class MysqlAdapter extends BaseAdapter {
  readonly dialect = 'mysql' as const
  readonly ddl = mysqlDdl
  readonly exporter = mysqlExporter
  readonly users = mysqlUsers
  private pool: Pool | null = null

  constructor(private readonly config: ConnectionConfig) {
    super()
  }

  private getPool(): Pool {
    if (this.pool) return this.pool
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      ...(this.config.database ? { database: this.config.database } : {}),
      connectionLimit: 4,
      connectTimeout: 10_000,
      idleTimeout: 60_000,
      multipleStatements: false,
      // BIGINT: number while it fits Number.MAX_SAFE_INTEGER, string beyond (same rule as the PostgreSQL int8 parser).
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: false,
      dateStrings: true,
      jsonStrings: true,
      rowsAsArray: true,
      charset: SESSION_COLLATION,
      // GEOMETRY arrives as the raw SRID+WKB bytes (a binary cell that round-trips through a dump) instead of
      // the driver's lossy {x, y} objects.
      typeCast: (field, next) => (field.type === 'GEOMETRY' ? field.buffer() : next()),
    })
    return this.pool
  }

  // Caches are keyed on the driver's core connection: the promise wrapper is a new object on every checkout,
  // the core connection is the pooled socket and therefore stable across checkouts.
  /** Connections whose socket died (e.g. KILL); destroyed instead of being returned to the pool. */
  private readonly broken = new WeakSet<object>()
  /** Database each pooled connection currently has selected (skips redundant USE + sql_mode setup). */
  private readonly currentDatabase = new WeakMap<object, string>()
  /** MariaDB has no max_execution_time; after the first ER_UNKNOWN_SYSTEM_VARIABLE the fallback variable is used. */
  private timeoutVariable: 'max_execution_time' | 'max_statement_time' = 'max_execution_time'

  private async run(
    conn: PoolConnection,
    text: string,
    params?: unknown[],
    options?: QueryOptions
  ): Promise<RawResult | RawResult[]> {
    try {
      const [rows, fields] = (await (params
        ? conn.query({ sql: text, values: params, rowsAsArray: true })
        : conn.query({ sql: text, rowsAsArray: true }))) as QueryOutput
      return normalise(rows, fields, options?.binaryLimit)
    } catch (err) {
      const mapped = this.toAdapterError(err)
      if (mapped.code === 'CONNECTION_FAILED') this.broken.add(conn.connection)
      throw mapped
    }
  }

  protected async acquire(ns: Namespace): Promise<Conn> {
    let conn: PoolConnection
    try {
      conn = await this.getPool().getConnection()
    } catch (err) {
      throw this.toAdapterError(err)
    }
    const core = conn.connection
    const release = () => (this.broken.has(core) ? conn.destroy() : conn.release())
    // `USE db` (plus the session sql_mode) only when the pooled connection is not already set up for that
    // database — a cache hit costs no round trip at all.
    if (this.currentDatabase.get(core) !== ns.database) {
      try {
        await this.run(conn, `USE ${quoteIdent('mysql', ns.database)}`)
        await this.run(conn, SESSION_SQL_MODE)
        this.currentDatabase.set(core, ns.database)
      } catch (err) {
        this.currentDatabase.delete(core)
        release()
        throw err
      }
    }
    const forget = () => this.currentDatabase.delete(core)
    // COM_RESET_CONNECTION (MySQL 5.7.3+ / MariaDB 10.2+) clears session variables, user variables, temp tables
    // and prepared statements without re-authenticating. It also reverts the session character set to the server
    // global, which may differ from the utf8mb4 negotiated at handshake, so SET NAMES is re-issued with the
    // handshake collation. A server that cannot reset gets the connection dropped.
    const reset = async () => {
      forget()
      try {
        await conn.reset()
        await this.run(conn, `SET NAMES utf8mb4 COLLATE ${SESSION_COLLATION}`)
      } catch {
        this.broken.add(core)
      }
    }
    return {
      query: (text, params, options) => this.run(conn, text, params, options),
      release,
      id: core,
      reset,
      forget,
      discard: () => this.broken.add(core),
    }
  }

  /**
   * sql_select_limit caps only top-level result sets (not INSERT ... SELECT, subqueries or CALL), honours a
   * smaller user LIMIT and keeps ORDER BY — exactly the row cap the console needs, without a derived table.
   * COM_RESET_CONNECTION after the script restores the server default.
   */
  protected override async capResultRows(conn: Conn, maxRows: number): Promise<boolean> {
    await conn.query(`SET SESSION sql_select_limit = ${Math.max(1, Math.floor(maxRows)) + 1}`)
    return true
  }

  protected override wrapperOnlyErrors(): ReadonlySet<string> {
    return WRAPPER_ONLY_ERRORS
  }

  protected override readonly castsKeyParams = true

  /** Placeholders are sent as string / double literals; these column types need the value coerced server-side. */
  protected override keyParam(placeholder: string, type: string): string {
    const t = type.toLowerCase()
    if (t.startsWith('json')) return `CAST(${placeholder} AS JSON)`
    // A FLOAT column holding 0.1 is not equal to the DOUBLE literal 0.1 (8.0.17+ / MariaDB 10.4.5+ syntax).
    if (t.startsWith('float')) return `CAST(${placeholder} AS FLOAT)`
    // Integers beyond 2^53 travel as strings; inside a row constructor MySQL compares them as DOUBLE (the
    // scalar `col = 'str'` path converts exactly, the `(a, b) > (?, ?)` path does not), so keyset paging
    // over a composite BIGINT key would skip rows. An UNSIGNED column needs the unsigned cast (2^64-2 as
    // SIGNED is -2).
    if (/^(?:big|medium|small|tiny)?int\b/.test(t)) {
      return t.includes('unsigned') ? `CAST(${placeholder} AS UNSIGNED)` : `CAST(${placeholder} AS SIGNED)`
    }
    // A BIT value travels as a binary literal (X'80'). MySQL reads that as a number in numeric context; MariaDB
    // reads it as a binary string and converts it to 0, so it is turned into a number explicitly.
    if (t.startsWith('bit')) return `CAST(CONV(HEX(${placeholder}), 16, 10) AS UNSIGNED)`
    const decimal = /^decimal\((\d+),\s*(\d+)\)/.exec(t)
    if (decimal) return `CAST(${placeholder} AS DECIMAL(${Number(decimal[1])},${Number(decimal[2])}))`
    return placeholder
  }

  /**
   * ENUM/SET order by member index but compare with a string literal by label: page over the label instead,
   * in the binary collation — CAST AS CHAR would take collation_connection (case-insensitive), making labels
   * that differ only by case or accent tie in ORDER BY and be skipped by the `>` comparison.
   */
  protected override keyColumnExpr(quoted: string, type: string): string {
    return /^(?:enum|set)\(/i.test(type) ? `CAST(${quoted} AS CHAR) COLLATE utf8mb4_bin` : quoted
  }

  protected async setStatementTimeout(conn: Conn, ms: number): Promise<void> {
    const millis = Math.max(0, Math.floor(ms))
    if (this.timeoutVariable === 'max_execution_time') {
      try {
        await conn.query(`SET SESSION max_execution_time = ${millis}`)
        return
      } catch (err) {
        if (!(err instanceof AdapterError) || err.nativeCode !== 'ER_UNKNOWN_SYSTEM_VARIABLE') throw err
        this.timeoutVariable = 'max_statement_time'
      }
    }
    // MariaDB: seconds with a fractional part. Unlike MySQL's SELECT-only max_execution_time it bounds every
    // statement — the same semantics as PostgreSQL's statement_timeout, so writes are limited there as well.
    await conn.query(`SET SESSION max_statement_time = ${millis / 1000}`)
  }

  protected async backendId(conn: Conn): Promise<string> {
    const r = firstResult(await conn.query('SELECT CONNECTION_ID()'))
    return String(r.rows[0]?.[0] ?? '')
  }

  /** KILL QUERY interrupts the statement but keeps the connection usable (unlike KILL). */
  protected async openCanceller(_ns: Namespace): Promise<Canceller> {
    let conn: Connection
    try {
      conn = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        connectTimeout: 10_000,
      })
    } catch (err) {
      throw this.toAdapterError(err)
    }
    return {
      cancel: async (id) => {
        try {
          await conn.query(`KILL QUERY ${id}`)
        } catch (err) {
          throw this.toAdapterError(err)
        }
      },
      close: () => conn.end().catch(() => undefined),
    }
  }

  protected nullSafeEq(): string {
    return '<=>'
  }

  protected fallbackKeyKind(): 'all-columns' {
    return 'all-columns'
  }

  protected fallbackKeySelect(): null {
    return null
  }

  async ping(): Promise<void> {
    try {
      await this.getPool().query('SELECT 1')
    } catch (err) {
      throw this.toAdapterError(err)
    }
  }

  async close(): Promise<void> {
    const pool = this.pool
    this.pool = null
    if (pool) await pool.end()
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    try {
      const [rows] = (await this.getPool().query({ sql: 'SHOW DATABASES', rowsAsArray: true })) as [
        unknown[][],
        unknown,
      ]
      // One aggregate over the catalog for every database (sizes are the storage engine's estimates).
      const [stats] = (await this.getPool().query({
        sql: 'SELECT TABLE_SCHEMA, SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)), COUNT(*) FROM information_schema.TABLES GROUP BY TABLE_SCHEMA',
        rowsAsArray: true,
      })) as [unknown[][], unknown]
      const byName = new Map(stats.map((r) => [String(r[0]), { size: Number(r[1]), count: Number(r[2]) }]))
      return rows
        .map((r) => {
          const name = String(r[0])
          const s = byName.get(name)
          return { name, sizeBytes: s ? s.size : 0, tableCount: s ? s.count : 0 }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      throw this.toAdapterError(err)
    }
  }

  async listSchemas(): Promise<string[]> {
    return []
  }

  listTables(ns: Namespace): Promise<TableInfo[]> {
    return this.withConn(ns, (conn) => mysqlListTables(conn, ns))
  }

  listRoutines(ns: Namespace): Promise<RoutineInfo[]> {
    return this.withConn(ns, (conn) => mysqlListRoutines(conn, ns))
  }

  routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null> {
    return this.withConn(ns, (conn) => mysqlRoutineDefinition(conn, ns, name, kind))
  }

  listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]> {
    return this.withConn(ns, (conn) => mysqlListTriggers(conn, ns, table))
  }

  listEvents(ns: Namespace): Promise<EventInfo[]> {
    return this.withConn(ns, (conn) => mysqlListEvents(conn, ns))
  }

  describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    return this.withConn(ns, (conn) => mysqlDescribeTable(conn, ns, table))
  }

  /** information_schema is readable by every account, so it is a safe namespace for server-level queries. */
  readonly serverNamespace: Namespace = { database: 'information_schema' }

  private serverNs(): Namespace {
    return this.serverNamespace
  }

  serverInfo(): Promise<ServerInfo> {
    return this.withConn(this.serverNs(), (conn) => mysqlServerInfo(conn))
  }

  listVariables(): Promise<KeyValue[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlListVariables(conn))
  }

  listStatus(): Promise<KeyValue[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlListStatus(conn))
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlListProcesses(conn))
  }

  killProcess(id: string): Promise<void> {
    return this.withConn(this.serverNs(), (conn) => mysqlKillProcess(conn, id))
  }

  listUsers(): Promise<UserInfo[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlListUsers(conn))
  }

  showGrants(user: UserRef, _ns?: Namespace): Promise<string[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlShowGrants(conn, user))
  }

  showCreateTable(ns: Namespace, table: string, known?: TableSchema): Promise<string[]> {
    return this.withConn(ns, async (conn) => {
      const t = quoteTable('mysql', ns, table)
      const r = firstResult(await conn.query(`SHOW CREATE TABLE ${t}`))
      const row = r.rows[0]
      if (!row) throw new AdapterError('NOT_FOUND', `Table not found: ${ns.database}.${table}`)
      const create = String(row[1] ?? '')
      // MariaDB answers SHOW CREATE TABLE for a sequence with `CREATE TABLE … SEQUENCE=1`: no catalog round trip
      // is needed to tell the two apart when the caller did not pass the schema.
      const kind = known?.kind ?? (/\bSEQUENCE=1\b/.test(create) ? 'sequence' : 'table')
      if (kind === 'sequence') {
        // MariaDB SEQUENCE: the definition plus the value it would hand out next, so a restore continues.
        const r = firstResult(await conn.query(`SHOW CREATE SEQUENCE ${t}`))
        const next = firstResult(await conn.query(`SELECT next_not_cached_value FROM ${t}`))
        const create = String(r.rows[0]?.[1] ?? '')
        const value = next.rows[0]?.[0]
        return value === null || value === undefined
          ? [create]
          : [
              create,
              `ALTER SEQUENCE ${quoteIdent('mysql', table)} RESTART WITH ${String(value).replace(/[^\d-]/g, '')}`,
            ]
      }
      // MariaDB prints sequence defaults database-qualified (`DEFAULT nextval(\`db\`.\`seq\`)`); a dump is
      // database-relative. Only the DEFAULT position is rewritten: a comment may quote the same text.
      const qualified = `DEFAULT nextval(${quoteIdent('mysql', ns.database)}.`
      return [create.replaceAll(qualified, 'DEFAULT nextval(')]
    })
  }

  toAdapterError(err: unknown): AdapterError {
    if (err instanceof AdapterError) return err
    const e = err as { code?: unknown; sqlMessage?: unknown; message?: unknown; errno?: unknown }
    const code =
      typeof e.code === 'string'
        ? e.code
        : typeof e.errno === 'number'
          ? (MARIADB_ERRNO_NAMES[e.errno] ?? `ER_${e.errno}`)
          : 'UNKNOWN'
    const detail =
      typeof e.sqlMessage === 'string' ? e.sqlMessage : typeof e.message === 'string' ? e.message : String(err)
    let kind: AdapterErrorCode = 'QUERY_FAILED'
    if (AUTH_CODES.has(code)) kind = 'AUTH_FAILED'
    else if (CONNECTION_CODES.has(code) || KILLED_CODES.has(code) || (e as { fatal?: boolean }).fatal === true)
      kind = 'CONNECTION_FAILED'
    else if (PERMISSION_CODES.has(code)) kind = 'PERMISSION_DENIED'
    else if (NOT_FOUND_CODES.has(code)) kind = 'NOT_FOUND'
    return new AdapterError(kind, `${code}: ${detail}`, detail, code === 'UNKNOWN' ? {} : { nativeCode: code })
  }
}
