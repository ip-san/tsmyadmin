import type {
  KeyValue,
  Namespace,
  ProcessInfo,
  ServerInfo,
  TableInfo,
  TableSchema,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import mysql, { type FieldPacket, type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise'
import { BaseAdapter, type Conn, firstResult, type RawResult } from '../base.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type AdapterErrorCode, type ConnectionConfig } from '../types.ts'
import { mysqlDdl } from './ddl.ts'
import { mysqlExporter } from './export.ts'
import { mysqlDescribeTable, mysqlListTables } from './introspect.ts'
import { mysqlKillProcess, mysqlListProcesses, mysqlListStatus, mysqlListVariables, mysqlServerInfo } from './server.ts'
import { mysqlListUsers, mysqlShowGrants, mysqlUsers } from './users.ts'
import { mysqlColumnMeta, mysqlToCell } from './values.ts'

const AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR'])
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ER_HOST_NOT_PRIVILEGED',
])
const NOT_FOUND_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_BAD_FIELD_ERROR'])
/** Killed connections surface as query interruption or a fatal protocol error. */
const KILLED_CODES = new Set(['ER_QUERY_INTERRUPTED', 'ER_CONNECTION_KILLED', 'PROTOCOL_CONNECTION_LOST'])

type QueryOutput = [unknown, FieldPacket[] | FieldPacket[][] | undefined]

function isHeader(v: unknown): v is ResultSetHeader {
  return typeof v === 'object' && v !== null && 'affectedRows' in v
}

function normalise(rowsOut: unknown, fields: FieldPacket[] | FieldPacket[][] | undefined): RawResult | RawResult[] {
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
        rows: (part as unknown[][]).map((r) => r.map(mysqlToCell)),
        affectedRows: 0,
        hasRows: true,
      })
    }
    return out
  }
  const single = (fields ?? []) as FieldPacket[]
  return {
    columns: single.map(mysqlColumnMeta),
    rows: (rows as unknown[][]).map((r) => r.map(mysqlToCell)),
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
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: false,
      dateStrings: true,
      jsonStrings: true,
      rowsAsArray: true,
    })
    return this.pool
  }

  /** Connections whose socket died (e.g. KILL); destroyed instead of being returned to the pool. */
  private readonly broken = new WeakSet<PoolConnection>()

  private async run(conn: PoolConnection, text: string, params?: unknown[]): Promise<RawResult | RawResult[]> {
    try {
      const [rows, fields] = (await (params
        ? conn.query({ sql: text, values: params, rowsAsArray: true })
        : conn.query({ sql: text, rowsAsArray: true }))) as QueryOutput
      return normalise(rows, fields)
    } catch (err) {
      const mapped = this.toAdapterError(err)
      if (mapped.code === 'CONNECTION_FAILED') this.broken.add(conn)
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
    const release = () => (this.broken.has(conn) ? conn.destroy() : conn.release())
    try {
      await this.run(conn, `USE ${quoteIdent('mysql', ns.database)}`)
    } catch (err) {
      release()
      throw err
    }
    return { query: (text, params) => this.run(conn, text, params), release }
  }

  protected async setStatementTimeout(conn: Conn, ms: number): Promise<void> {
    await conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(ms))}`)
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

  async listDatabases(): Promise<{ name: string }[]> {
    try {
      const [rows] = (await this.getPool().query({ sql: 'SHOW DATABASES', rowsAsArray: true })) as [
        unknown[][],
        unknown,
      ]
      return rows.map((r) => ({ name: String(r[0]) })).sort((a, b) => a.name.localeCompare(b.name))
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

  describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    return this.withConn(ns, (conn) => mysqlDescribeTable(conn, ns, table))
  }

  /** information_schema is readable by every account, so it is a safe namespace for server-level queries. */
  private serverNs(): Namespace {
    return { database: 'information_schema' }
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

  showGrants(user: UserRef): Promise<string[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlShowGrants(conn, user))
  }

  showCreateTable(ns: Namespace, table: string): Promise<string[]> {
    return this.withConn(ns, async (conn) => {
      const r = firstResult(await conn.query(`SHOW CREATE TABLE ${quoteTable('mysql', ns, table)}`))
      const row = r.rows[0]
      if (!row) throw new AdapterError('NOT_FOUND', `Table not found: ${ns.database}.${table}`)
      return [String(row[1] ?? '')]
    })
  }

  toAdapterError(err: unknown): AdapterError {
    if (err instanceof AdapterError) return err
    const e = err as { code?: unknown; sqlMessage?: unknown; message?: unknown; errno?: unknown }
    const code = typeof e.code === 'string' ? e.code : 'UNKNOWN'
    const detail =
      typeof e.sqlMessage === 'string' ? e.sqlMessage : typeof e.message === 'string' ? e.message : String(err)
    let kind: AdapterErrorCode = 'QUERY_FAILED'
    if (AUTH_CODES.has(code)) kind = 'AUTH_FAILED'
    else if (CONNECTION_CODES.has(code) || KILLED_CODES.has(code) || (e as { fatal?: boolean }).fatal === true)
      kind = 'CONNECTION_FAILED'
    else if (NOT_FOUND_CODES.has(code)) kind = 'NOT_FOUND'
    return new AdapterError(kind, `${code}: ${detail}`, detail)
  }
}
