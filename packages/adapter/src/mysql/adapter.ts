import type {
  DatabaseGrant,
  DatabaseInfo,
  DdlOp,
  DiagnosticKind,
  DiagnosticQuery,
  DiagnosticReport,
  EventDetail,
  EventInfo,
  ExplainResult,
  KeyValue,
  KillMode,
  LockWaitReport,
  Namespace,
  ObjectDependency,
  Partitioning,
  ProcessInfo,
  ProfileStage,
  RelationDef,
  ReplicationInfo,
  RoutineDetail,
  RoutineInfo,
  RoutineKind,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
  TableInfo,
  TableSchema,
  TableStats,
  TableUsageReport,
  TriggerDetail,
  TriggerInfo,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import type { Connection as CoreConnection } from 'mysql2'
import mysql, { type Connection, type FieldPacket, type Pool, type PoolConnection } from 'mysql2/promise'
import { BaseAdapter } from '../base.ts'
import { type Canceller, type Conn, firstResult, type RawResult, withinAcquireTimeout } from '../driver.ts'
import type { QueryOptions } from '../sql/cells.ts'
import { explainableStatement, explainResult, measurableStatement, parseJsonCell } from '../sql/explain-statement.ts'
import { quoteIdent } from '../sql/quote.ts'
import { AdapterError, type ConnectionConfig, type RowBatch } from '../types.ts'
import { mysqlRecoverLossyDefaults, mysqlShowCreateTable } from './create-statements.ts'
import { mysqlDdl } from './ddl.ts'
import { mapMysqlError } from './errors.ts'
import { mysqlExecutionMs, needsFormat1, parseMysqlPlan } from './explain.ts'
import { mysqlExporter } from './export.ts'
import {
  mysqlDatabaseGrants,
  mysqlDescribeTable,
  mysqlListForeignKeys,
  mysqlListPartitions,
  mysqlListTables,
  mysqlTableStats,
} from './introspect.ts'
import { keyMatchExpr, keyParam } from './key-types.ts'
import { normalise } from './normalise.ts'
import { mysqlPrepareDdl } from './prepare-ddl.ts'
import { mysqlEventDetail, mysqlRoutineDetail, mysqlTriggerDetail } from './program-detail.ts'
import {
  mysqlListDependencies,
  mysqlListEvents,
  mysqlListRoutines,
  mysqlListTriggers,
  mysqlRoutineDefinition,
} from './routines.ts'
import { mysqlScanPlan, mysqlScanRows, mysqlStreamRows } from './scan.ts'
import {
  mysqlDiagnostics,
  mysqlKillProcess,
  mysqlListProcesses,
  mysqlListStatus,
  mysqlListVariables,
  mysqlLockWaits,
  mysqlReplicationInfo,
  mysqlServerCatalog,
  mysqlServerInfo,
  mysqlTableUsage,
} from './server.ts'
import { mysqlCanManageAccount, mysqlListUsers, mysqlShowGrants, mysqlUsers } from './users.ts'

/** Derived-table wrapping (only used for statements with their own LIMIT) fails where the bare statement would not. */
const WRAPPER_ONLY_ERRORS: ReadonlySet<string> = new Set([
  'ER_DUP_FIELDNAME',
  'ER_CANT_USE_OPTION_HERE',
  'ER_PARSE_ERROR',
])
type QueryOutput = [unknown, FieldPacket[] | FieldPacket[][] | undefined]

/** A statement interrupted: by KILL QUERY or a time limit (ER_QUERY_INTERRUPTED, ER_QUERY_TIMEOUT, MariaDB's 1969). */
const INTERRUPTED: ReadonlySet<number> = new Set([1317, 3024, 1969])
/** Collation negotiated at handshake unless the login chose another; SET NAMES after a connection reset must restore it. */
const DEFAULT_COLLATION = 'utf8mb4_unicode_ci'
/** How many of the pool's own thread ids are remembered (see `ownThreads`). */
const OWN_THREADS_KEPT = 64
/**
 * Placeholder values are escaped client-side by the driver with backslashes (mysql2 does not prepare `query()`);
 * a server running with NO_BACKSLASH_ESCAPES would read `\'` as a backslash plus a string terminator, turning any
 * quote in a filter value or row key into a syntax error or a WHERE-clause injection. The flag is removed from
 * the *session* mode (everything else is kept), so DDL literals built by `mysqlLiteral` are safe as well.
 */
const SESSION_SQL_MODE =
  "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))"

export class MysqlAdapter extends BaseAdapter {
  readonly dialect = 'mysql' as const
  readonly ddl = mysqlDdl
  readonly exporter = mysqlExporter
  readonly users = mysqlUsers
  private pool: Pool | null = null
  /** Thread ids of the connections this pool opened (the latest few: the pool is small, connections come and go). */
  private readonly ownThreads: number[] = []

  constructor(private readonly config: ConnectionConfig) {
    super()
  }

  /** The connection's collation. It reaches `SET NAMES` as text, so it is checked here as well as at login. */
  private get collation(): string {
    const chosen = this.config.collation ?? DEFAULT_COLLATION
    // A character set alone (`utf8mb4`) is not a collation: SET NAMES x COLLATE x would fail on every reset.
    if (!/^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(chosen))
      throw new AdapterError('VALIDATION', `Not a collation name: ${chosen}`)
    return chosen
  }

  /**
   * A pooled connection, or CONNECTION_FAILED if none became free in ACQUIRE_TIMEOUT_MS: mysql2 would queue the
   * request for as long as the four connections stay busy (see withinAcquireTimeout).
   */
  private getConnection(): Promise<PoolConnection> {
    return withinAcquireTimeout(this.getPool().getConnection())
  }

  /** A connection for one call, under the same acquire timeout: `pool.query` itself would wait without end. */
  private async withPoolConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.getConnection()
    try {
      return await fn(conn)
    } finally {
      conn.release()
    }
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
      // performance_schema.session_connect_attrs: the process list marks the tool's own connections.
      connectAttributes: { program_name: 'tsmyadmin' },
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
      charset: this.collation,
      // GEOMETRY arrives as the raw SRID+WKB bytes (a binary cell that round-trips through a dump) instead of
      // the driver's lossy {x, y} objects.
      typeCast: (field, next) => (field.type === 'GEOMETRY' ? field.buffer() : next()),
    })
    // The general log names a statement's connection by thread id: these are the ones to leave out of its history.
    // (The event hands over the driver's core connection, not the promise wrapper the typings describe.)
    this.pool.on('connection', (conn) => {
      this.ownThreads.push((conn as unknown as CoreConnection).threadId)
      if (this.ownThreads.length > OWN_THREADS_KEPT) this.ownThreads.shift()
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
  /** Read from the first connection: MariaDB numbers its own errors from 4000 up, where MySQL 8 has other names. */
  private mariadb: boolean | null = null

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
      return normalise(rows, fields, options)
    } catch (err) {
      const mapped = this.toAdapterError(err)
      if (mapped.code === 'CONNECTION_FAILED') this.broken.add(conn.connection)
      throw mapped
    }
  }

  protected async acquire(ns: Namespace): Promise<Conn> {
    let conn: PoolConnection
    try {
      conn = await this.getConnection()
    } catch (err) {
      throw this.toAdapterError(err)
    }
    const core = conn.connection
    const release = () => (this.broken.has(core) ? conn.destroy() : conn.release())
    if (this.mariadb === null) {
      try {
        const v = await this.run(conn, 'SELECT VERSION()')
        this.mariadb = /mariadb/i.test(String((Array.isArray(v) ? v[0] : v)?.rows[0]?.[0] ?? ''))
      } catch (err) {
        release()
        throw err
      }
    }
    // `USE db` (plus the session sql_mode) only when the pooled connection is not already set up for that
    // database — a cache hit costs no round trip at all.
    if (this.currentDatabase.get(core) !== ns.database) {
      try {
        await this.run(conn, `USE ${quoteIdent('mysql', ns.database)}`)
        await this.run(conn, SESSION_SQL_MODE)
        // MySQL 8 serves information_schema statistics (AUTO_INCREMENT, TABLE_ROWS, sizes) from a 24-hour cache
        // by default; the structure pages must show what the server has now. MariaDB / 5.7 lack the variable.
        if (!this.mariadb) {
          try {
            await this.run(conn, 'SET SESSION information_schema_stats_expiry = 0')
          } catch (err) {
            if (!(err instanceof AdapterError && err.nativeCode === 'ER_UNKNOWN_SYSTEM_VARIABLE')) throw err
          }
        }
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
        await this.run(conn, `SET NAMES ${this.collation.split('_')[0]} COLLATE ${this.collation}`)
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
      inTransaction: async () => {
        // `DO 0` is the cheapest statement that neither starts nor ends a transaction; its OK packet carries
        // the server status, whose lowest bit is SERVER_STATUS_IN_TRANS. A cancel still in flight can kill the
        // probe itself, which would answer "nothing open" for a transaction that is; by then the cancel has
        // been delivered, so one retry settles it.
        for (let attempt = 0; ; attempt++) {
          try {
            const [res] = await conn.query('DO 0')
            return ((res as { serverStatus?: number }).serverStatus ?? 0) % 2 === 1
          } catch (err) {
            if (attempt > 0 || (err as { code?: string }).code !== 'ER_QUERY_INTERRUPTED') throw err
          }
        }
      },
      stream: (text, params, batchSize, options) => this.streamRows(conn, text, params, batchSize, options),
    }
  }

  /** One SELECT read row by row (see `mysqlStreamRows`); a lost or abandoned connection is not handed back. */
  private streamRows(
    conn: PoolConnection,
    text: string,
    params: unknown[],
    batchSize: number,
    options?: QueryOptions
  ): AsyncIterable<RawResult> {
    const fail = (err: unknown) => {
      const mapped = this.toAdapterError(err)
      if (mapped.code === 'CONNECTION_FAILED') this.broken.add(conn.connection)
      return mapped
    }
    return mysqlStreamRows(conn, text, params, batchSize, options, fail, () => this.broken.add(conn.connection))
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

  // SHOW PROFILE is deprecated in MySQL 8 but still answers there and on MariaDB, where it is the only per-stage
  // timing a session can ask for without the privileges performance_schema's history tables need.
  protected override async startProfiling(conn: Conn): Promise<boolean> {
    try {
      await conn.query('SET SESSION profiling = 1')
      return true
    } catch {
      return false
    }
  }

  protected override async readProfile(conn: Conn): Promise<ProfileStage[]> {
    const r = firstResult(await conn.query('SHOW PROFILE'))
    return r.rows.map((row) => ({ state: String(row[0] ?? ''), seconds: Number(row[1] ?? 0) }))
  }

  protected override wrapperOnlyErrors(): ReadonlySet<string> {
    return WRAPPER_ONLY_ERRORS
  }

  protected override readonly castsKeyParams = true

  /** Placeholders are sent as string / double literals; these column types need the value coerced server-side. */
  protected override keyParam(placeholder: string, type: string): string {
    return keyParam(placeholder, type)
  }

  protected override keyMatchExpr(expr: string, type: string): string {
    return keyMatchExpr(expr, type)
  }

  /**
   * Stable-order full scan with keyset pagination: PK (or NOT NULL unique key) → `WHERE (k1, k2) > (last)`
   * ordered by the key; without a key → one unordered SELECT streamed from the driver in batches (no total order
   * exists to page over). Keyset paging keeps each batch O(batch) instead of OFFSET's O(offset + batch) rescans
   * on large tables. PostgreSQL scans with a server-side cursor instead (see its iterateRows).
   */
  async *iterateRows(
    ns: Namespace,
    table: string,
    opts: { batchSize: number; schema?: TableSchema; utc?: boolean }
  ): AsyncIterable<RowBatch> {
    const schema = opts.schema ?? (await this.describeTable(ns, table))
    const plan = mysqlScanPlan(ns, table, schema, this.resolveRowKey(schema), opts.batchSize)
    // Generators cannot run inside withConn's callback, so the borrow/done pair is shared instead
    // (no statement timeout: full scans may legitimately be long).
    const { conn, done } = await this.borrow(ns, 0)
    try {
      yield* mysqlScanRows(conn, plan, opts.utc === true)
    } finally {
      // After a utc scan the session is not the one the next borrower expects (reset() also drops the cached current
      // database and marks the connection broken if the reset fails).
      if (opts.utc) await conn.reset()
      await done()
    }
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
      await this.withPoolConnection((c) => c.query('SELECT 1'))
    } catch (err) {
      throw this.toAdapterError(err)
    }
  }

  async close(): Promise<void> {
    const pool = this.pool
    this.pool = null
    if (pool) await pool.end()
  }

  async listDatabases({ stats: withStats = true }: { stats?: boolean } = {}): Promise<DatabaseInfo[]> {
    try {
      const [rows] = (await this.withPoolConnection((c) => c.query({ sql: 'SHOW DATABASES', rowsAsArray: true }))) as [
        unknown[][],
        unknown,
      ]
      // One aggregate over the catalog for every database (sizes are the storage engine's estimates).
      const [stats] = withStats
        ? ((await this.withPoolConnection((c) =>
            c.query({
              sql: 'SELECT TABLE_SCHEMA, SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)), COUNT(*) FROM information_schema.TABLES GROUP BY TABLE_SCHEMA',
              rowsAsArray: true,
            })
          )) as [unknown[][], unknown])
        : [[] as unknown[][]]
      const byName = new Map(stats.map((r) => [String(r[0]), { size: Number(r[1]), count: Number(r[2]) }]))
      const [schemata] = (await this.withPoolConnection((c) =>
        c.query({
          sql: 'SELECT SCHEMA_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA',
          rowsAsArray: true,
        })
      )) as [unknown[][], unknown]
      const collations = new Map(schemata.map((r) => [String(r[0]), r[1] === null ? null : String(r[1])]))
      return rows
        .map((r) => {
          const name = String(r[0])
          const s = byName.get(name)
          return {
            name,
            sizeBytes: withStats ? (s ? s.size : 0) : null,
            tableCount: withStats ? (s ? s.count : 0) : null,
            collation: collations.get(name) ?? null,
          }
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

  routineDetail(ns: Namespace, name: string, kind: RoutineKind): Promise<RoutineDetail | null> {
    return this.withConn(ns, (conn) => mysqlRoutineDetail(conn, ns, name, kind))
  }

  triggerDetail(ns: Namespace, table: string, name: string): Promise<TriggerDetail | null> {
    return this.withConn(ns, (conn) => mysqlTriggerDetail(conn, ns, table, name))
  }

  eventDetail(ns: Namespace, name: string): Promise<EventDetail | null> {
    return this.withConn(ns, (conn) => mysqlEventDetail(conn, ns, name))
  }

  listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]> {
    return this.withConn(ns, (conn) => mysqlListTriggers(conn, ns, table))
  }

  listEvents(ns: Namespace): Promise<EventInfo[]> {
    return this.withConn(ns, (conn) => mysqlListEvents(conn, ns))
  }

  listDependencies(ns: Namespace): Promise<ObjectDependency[] | null> {
    return this.withConn(ns, (conn) => mysqlListDependencies(conn, ns))
  }

  prepareDdl(ns: Namespace, op: DdlOp): Promise<DdlOp> {
    return mysqlPrepareDdl(this, ns, op)
  }

  listForeignKeys(ns: Namespace): Promise<RelationDef[]> {
    return this.withConn(ns, (conn) => mysqlListForeignKeys(conn, ns))
  }
  tableUsage(ns: Namespace): Promise<TableUsageReport> {
    return this.withConn(ns, (conn) => mysqlTableUsage(conn, ns.database))
  }

  /**
   * MySQL measures in JSON only in format 2 (8.3+), which this session asks for and gives back; MariaDB has its own
   * `ANALYZE FORMAT=JSON`. Both run the statement: READ ONLY here, since only a read is taken.
   */
  async analyzePlan(ns: Namespace, sql: string, timeoutMs: number): Promise<ExplainResult> {
    const statement = measurableStatement(sql, 'mysql')
    return this.withConn(
      ns,
      async (conn) => {
        const mariadb = this.mariadb === true
        if (!mariadb) await this.jsonFormat2(conn)
        try {
          await conn.query('START TRANSACTION READ ONLY')
          try {
            const sent = mariadb ? `ANALYZE FORMAT=JSON ${statement}` : `EXPLAIN ANALYZE FORMAT=JSON ${statement}`
            const raw = parseJsonCell(firstResult(await conn.query(sent)).rows[0]?.[0] ?? null)
            // MySQL stopped by its time limit still answers, with the plan of a run cut short (the steps it had not
            // reached say nothing, the top one says 0 rows): only a warning tells.
            const warnings = firstResult(await conn.query('SHOW WARNINGS')).rows
            if (warnings.some((w) => INTERRUPTED.has(Number(w[1])))) {
              throw new AdapterError('QUERY_FAILED', 'The statement was stopped before it finished (its time ran out)')
            }
            return explainResult(parseMysqlPlan(raw, statement), raw, { ms: mysqlExecutionMs(raw) })
          } finally {
            await conn.query('ROLLBACK')
          }
        } finally {
          if (!mariadb) await conn.query('SET SESSION explain_json_format_version = DEFAULT')
        }
      },
      timeoutMs
    )
  }

  /** Format 2 for this session; a server without the variable (before 8.3) cannot measure in JSON. */
  private async jsonFormat2(conn: Conn): Promise<void> {
    try {
      await conn.query('SET SESSION explain_json_format_version = 2')
    } catch (err) {
      if (err instanceof AdapterError && err.nativeCode === 'ER_UNKNOWN_SYSTEM_VARIABLE') {
        throw new AdapterError('UNSUPPORTED', 'Measuring a plan needs MySQL 8.3 or later')
      }
      throw err
    }
  }

  /**
   * Not READ ONLY: MySQL refuses to EXPLAIN an UPDATE in a read-only transaction. The optimizer may still call a
   * function it can fold to a constant; what that writes is rolled back.
   */
  async explainPlan(ns: Namespace, sql: string): Promise<ExplainResult> {
    const statement = explainableStatement(sql, 'mysql')
    return this.withConn(ns, async (conn) => {
      const read = async () =>
        parseJsonCell(firstResult(await conn.query(`EXPLAIN FORMAT=JSON ${statement}`)).rows[0]?.[0] ?? null)
      await conn.query('START TRANSACTION')
      try {
        let raw = await read()
        // Format 2 (MySQL 9's default) has no plan for an UPDATE or DELETE; format 1 has.
        if (needsFormat1(raw)) {
          await conn.query('SET SESSION explain_json_format_version = 1')
          try {
            raw = await read()
          } finally {
            await conn.query('SET SESSION explain_json_format_version = DEFAULT')
          }
        }
        return explainResult(parseMysqlPlan(raw, statement), raw)
      } finally {
        await conn.query('ROLLBACK')
      }
    })
  }

  listPartitions(ns: Namespace, table: string): Promise<Partitioning> {
    return this.withConn(ns, (conn) => mysqlListPartitions(conn, ns, table))
  }

  databaseGrants(database: string): Promise<DatabaseGrant[]> {
    // Read through the server's own schema: the database asked about may not exist (yet), and need not be entered.
    return this.withConn(this.serverNamespace, (conn) => mysqlDatabaseGrants(conn, database))
  }

  tableStats(ns: Namespace, table: string): Promise<TableStats> {
    return this.withConn(ns, (conn) => mysqlTableStats(conn, ns, table))
  }

  describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    return this.withConn(ns, async (conn) => {
      const schema = await mysqlDescribeTable(conn, ns, table, this.mariadb === true)
      if (this.mariadb !== true) await mysqlRecoverLossyDefaults(conn, ns, table, schema.columns)
      return schema
    })
  }

  /** information_schema is readable by every account, so it is a safe namespace for server-level queries. */
  readonly serverNamespace: Namespace = { database: 'information_schema' }

  private serverNs(): Namespace {
    return this.serverNamespace
  }

  serverInfo(): Promise<ServerInfo> {
    return this.withConn(this.serverNs(), (conn) => mysqlServerInfo(conn))
  }

  replicationInfo(): Promise<ReplicationInfo> {
    return this.withConn(this.serverNs(), (conn) => mysqlReplicationInfo(conn))
  }

  diagnostics(kind: DiagnosticKind, query?: DiagnosticQuery): Promise<DiagnosticReport> {
    return this.withConn(this.serverNs(), (conn) => mysqlDiagnostics(conn, kind, query, this.ownThreads))
  }

  serverCatalog(kind: ServerCatalogKind): Promise<ServerCatalog> {
    return this.withConn(this.serverNs(), (conn) => mysqlServerCatalog(conn, kind))
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

  killProcess(id: string, mode: KillMode = 'connection'): Promise<void> {
    return this.withConn(this.serverNs(), (conn) => mysqlKillProcess(conn, id, mode))
  }

  lockWaits(): Promise<LockWaitReport> {
    return this.withConn(this.serverNs(), (conn) => mysqlLockWaits(conn))
  }

  listUsers(): Promise<UserInfo[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlListUsers(conn))
  }

  showGrants(user: UserRef, _ns?: Namespace): Promise<string[]> {
    return this.withConn(this.serverNs(), (conn) => mysqlShowGrants(conn, user))
  }

  /** The name does not change the answer here: MySQL's CREATE USER reaches every account (SYSTEM_USER aside). */
  canManageAccount(_name: string): Promise<boolean> {
    return this.withConn(this.serverNs(), (conn) => mysqlCanManageAccount(conn))
  }

  showCreateTable(ns: Namespace, table: string, known?: TableSchema): Promise<string[]> {
    return this.withConn(ns, (conn) => mysqlShowCreateTable(conn, ns, table, known))
  }

  toAdapterError(err: unknown): AdapterError {
    return mapMysqlError(err, this.mariadb === true)
  }
}
