import type {
  ColumnMeta,
  DatabaseInfo,
  EventInfo,
  KeyValue,
  Namespace,
  ObjectDependency,
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
import { isViewKind } from '@tsmyadmin/shared'
import pg, { type FieldDef, type PoolClient, type QueryResult } from 'pg'
import {
  BaseAdapter,
  type Canceller,
  type Conn,
  driverValueToCell,
  firstResult,
  type QueryOptions,
  type RawResult,
} from '../base.ts'
import { pgLiteral } from '../sql/literal.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type AdapterErrorCode, type ConnectionConfig, type RowBatch } from '../types.ts'
import { pgCreateStatements, pgDdl, pgTableCatalog } from './ddl.ts'
import { pgExporter } from './export.ts'
import { pgDescribeTable, pgListSchemas, pgListTables } from './introspect.ts'
import { pgListDependencies, pgListRoutines, pgListTriggers, pgRoutineDefinition } from './routines.ts'
import { pgKillProcess, pgListProcesses, pgListStatus, pgListVariables, pgServerInfo } from './server.ts'
import { pgListUsers, pgShowGrants, pgUsers } from './users.ts'
import { PG_TYPE_NAMES, pgTypes } from './values.ts'

const AUTH_CODES = new Set(['28P01', '28000'])
/** Socket-level failures reported without a SQLSTATE (e.g. after pg_terminate_backend). */
const CONNECTION_MESSAGES = /terminat|closed|ECONNRESET/i
const NOT_FOUND_CODES = new Set(['3D000', '3F000', '42P01', '42703'])
/** insufficient_privilege */
const PERMISSION_CODES = new Set(['42501'])
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  '57P01',
  '57P03',
])

type ArrayResult = QueryResult<unknown[]>

export class PostgresAdapter extends BaseAdapter {
  readonly dialect = 'postgres' as const
  readonly ddl = pgDdl
  readonly exporter = pgExporter
  readonly users = pgUsers
  private readonly pools = new Map<string, pg.Pool>()
  /** search_path each pooled client currently has (skips redundant SET). */
  private readonly currentSchema = new WeakMap<PoolClient, string>()
  private readonly typeNames = new Map<number, string>(Object.entries(PG_TYPE_NAMES).map(([k, v]) => [Number(k), v]))

  constructor(private readonly config: ConnectionConfig) {
    super()
  }

  private defaultDatabase(): string {
    return this.config.database ?? 'postgres'
  }

  private poolFor(database: string): pg.Pool {
    const existing = this.pools.get(database)
    if (existing) return existing
    const pool = new pg.Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database,
      max: 4,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
      types: pgTypes,
    })
    pool.on('error', () => undefined)
    // One pool per browsed database: drop it once its last idle client timed out so a session that walked
    // through many databases does not keep a pool object (and its 'remove' timers) per database forever.
    pool.on('remove', () => {
      if (database === this.defaultDatabase() || this.pools.get(database) !== pool) return
      if (pool.totalCount === 0 && pool.waitingCount === 0) {
        this.pools.delete(database)
        pool.end().catch(() => undefined)
      }
    })
    this.pools.set(database, pool)
    return pool
  }

  private async columnMetas(client: PoolClient, fields: FieldDef[]): Promise<ColumnMeta[]> {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID).filter((oid) => !this.typeNames.has(oid)))]
    if (unknown.length > 0) {
      // Through run() so a failure is an AdapterError and a dead client is marked broken like any other query.
      // NB: run() → toRaw() → columnMetas() recurses; it terminates because this SELECT's own column types
      // (text = 25, name = 19) are in the static PG_TYPE_NAMES table — keep them there. oid::text avoids the
      // int4 wraparound of OIDs ≥ 2^31.
      const res = firstResult(
        await this.run(client, 'SELECT oid::text AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])', [unknown])
      )
      for (const row of res.rows) this.typeNames.set(Number(row[0]), String(row[1]))
    }
    return fields.map((f) => ({ name: f.name, dataType: this.typeNames.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` }))
  }

  private async toRaw(client: PoolClient, res: ArrayResult, binaryLimit?: number): Promise<RawResult> {
    const hasRows = res.fields.length > 0
    return {
      columns: hasRows ? await this.columnMetas(client, res.fields) : [],
      rows: hasRows ? res.rows.map((r) => r.map((v) => driverValueToCell(v, binaryLimit))) : [],
      affectedRows: res.rowCount ?? 0,
      hasRows,
    }
  }

  /** Clients whose socket died (e.g. pg_terminate_backend); they must be discarded, not returned to the pool. */
  private readonly broken = new WeakSet<PoolClient>()
  private readonly guarded = new WeakSet<PoolClient>()

  private async run(
    client: PoolClient,
    text: string,
    params?: unknown[],
    options?: QueryOptions
  ): Promise<RawResult | RawResult[]> {
    let res: ArrayResult | ArrayResult[]
    try {
      res = params
        ? await client.query<unknown[]>({ text, values: params, rowMode: 'array' })
        : ((await client.query<unknown[]>({ text, rowMode: 'array' })) as ArrayResult | ArrayResult[])
    } catch (err) {
      const mapped = this.toAdapterError(err)
      if (mapped.code === 'CONNECTION_FAILED') this.broken.add(client)
      throw mapped
    }
    if (Array.isArray(res)) {
      const out: RawResult[] = []
      for (const r of res) out.push(await this.toRaw(client, r, options?.binaryLimit))
      return out
    }
    return this.toRaw(client, res, options?.binaryLimit)
  }

  protected async acquire(ns: Namespace): Promise<Conn> {
    let client: PoolClient
    const pool = this.poolFor(ns.database)
    try {
      client = await pool.connect()
    } catch (err) {
      // pg-pool emits no 'remove' for a failed connect, so an unreachable database would keep its pool forever.
      if (ns.database !== this.defaultDatabase() && pool.totalCount === 0 && pool.waitingCount === 0) {
        this.pools.delete(ns.database)
        pool.end().catch(() => undefined)
      }
      throw this.toAdapterError(err)
    }
    if (!this.guarded.has(client)) {
      // A terminated backend emits 'error' asynchronously; without a listener Node treats it as unhandled.
      client.on('error', () => this.broken.add(client))
      this.guarded.add(client)
    }
    const release = () => client.release(this.broken.has(client) ? new Error('connection terminated') : undefined)
    const schema = ns.schema ?? 'public'
    // SET search_path only when the pooled client is not already on that schema (one round trip per request saved).
    if (this.currentSchema.get(client) !== schema) {
      try {
        await this.run(client, `SET search_path TO ${quoteIdent('postgres', schema)}`)
        this.currentSchema.set(client, schema)
      } catch (err) {
        this.currentSchema.delete(client)
        release()
        throw err
      }
    }
    const forget = () => this.currentSchema.delete(client)
    // DISCARD ALL = RESET ALL + SET SESSION AUTHORIZATION DEFAULT + DEALLOCATE/CLOSE/UNLISTEN + temp tables.
    // It cannot run inside a transaction; executeSql issues ROLLBACK first. run() marks a dead client broken.
    const reset = async () => {
      forget()
      try {
        await this.run(client, 'DISCARD ALL')
      } catch {
        this.broken.add(client)
      }
    }
    return {
      query: (text, params, options) => this.run(client, text, params, options),
      release,
      id: client,
      reset,
      forget,
      discard: () => this.broken.add(client),
    }
  }

  /**
   * Server-side cursor instead of keyset paging: O(N) for every relation (a ctid keyset rescans the heap per
   * batch, and key-less relations would otherwise be read in one unbounded SELECT), memory bounded to one
   * batch, and `ONLY` so an inheritance parent yields its own rows exactly once — pg_dump semantics. Rows are
   * ordered by the primary key when there is one (an index scan; cursors favour fast-start plans).
   */
  override async *iterateRows(
    ns: Namespace,
    table: string,
    opts: { batchSize: number; schema?: TableSchema }
  ): AsyncIterable<RowBatch> {
    const schema = opts.schema ?? (await this.describeTable(ns, table))
    const columns = schema.columns.map((c) => quoteIdent('postgres', c.name)).join(', ')
    // A partitioned parent holds no rows itself; every other relation kind accepts ONLY (views included).
    const source = `${schema.partitioned ? '' : 'ONLY '}${quoteTable('postgres', ns, table)}`
    const key = this.resolveRowKey(schema)
    const orderBy =
      key.keyKind === 'pk' ? ` ORDER BY ${key.keyColumns.map((c) => quoteIdent('postgres', c)).join(', ')}` : ''
    const batchSize = Math.max(1, Math.floor(opts.batchSize))
    const { conn, done } = await this.borrow(ns, 0)
    // A consumer that stops early (a cancelled download) resumes the generator with return(): only this finally
    // runs, so the transaction must be closed here or the pooled connection would go back "idle in transaction"
    // with the cursor open and a lock on the table.
    let committed = false
    try {
      await conn.query('BEGIN')
      await conn.query(`DECLARE tsmyadmin_export NO SCROLL CURSOR FOR SELECT ${columns} FROM ${source}${orderBy}`)
      let first = true
      for (;;) {
        const r = firstResult(
          await conn.query(`FETCH ${batchSize} FROM tsmyadmin_export`, undefined, {
            binaryLimit: Number.POSITIVE_INFINITY,
          })
        )
        // An empty table still yields one batch so callers learn the column list.
        if (r.rows.length > 0 || first) yield { columns: r.columns, rows: r.rows }
        first = false
        if (r.rows.length < batchSize) break
      }
      await conn.query('CLOSE tsmyadmin_export')
      await conn.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await conn.query('ROLLBACK').catch(() => undefined)
      await done()
    }
  }

  protected async setStatementTimeout(conn: Conn, ms: number): Promise<void> {
    await conn.query(`SET statement_timeout = ${Math.max(0, Math.floor(ms))}`)
  }

  protected async backendId(conn: Conn): Promise<string> {
    const r = firstResult(await conn.query('SELECT pg_backend_pid()'))
    return String(r.rows[0]?.[0] ?? '')
  }

  /** pg_cancel_backend interrupts the statement but keeps the session (pg_terminate_backend would drop it). */
  protected async openCanceller(_ns: Namespace): Promise<Canceller> {
    // A dedicated connection: the pools may be saturated by the very scripts being cancelled, and
    // pg_cancel_backend works from any database.
    const client = new pg.Client({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.defaultDatabase(),
      connectionTimeoutMillis: 10_000,
    })
    try {
      await client.connect()
    } catch (err) {
      await client.end().catch(() => undefined)
      throw this.toAdapterError(err)
    }
    return {
      cancel: async (id) => {
        try {
          await client.query('SELECT pg_cancel_backend($1::int)', [Number(id)])
        } catch (err) {
          throw this.toAdapterError(err)
        }
      },
      close: () => client.end().catch(() => undefined),
    }
  }

  protected nullSafeEq(): string {
    return 'IS NOT DISTINCT FROM'
  }

  protected fallbackKeyKind(): 'ctid' {
    return 'ctid'
  }

  protected fallbackKeySelect(): string {
    return 'ctid::text AS "ctid"'
  }

  async ping(): Promise<void> {
    try {
      await this.poolFor(this.defaultDatabase()).query('SELECT 1')
    } catch (err) {
      throw this.toAdapterError(err)
    }
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(pools.map((p) => p.end()))
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    try {
      // pg_database_size needs CONNECT on the database; others are reported without a size.
      const res = await this.poolFor(this.defaultDatabase()).query<{ datname: string; size: string | null }>(
        `SELECT datname, CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_database_size(datname) END AS size
         FROM pg_database WHERE datistemplate = false ORDER BY datname`
      )
      return res.rows.map((r) => ({
        name: r.datname,
        sizeBytes: r.size === null ? null : Number(r.size),
        tableCount: null,
      }))
    } catch (err) {
      throw this.toAdapterError(err)
    }
  }

  listSchemas(database: string): Promise<string[]> {
    return this.withConn({ database }, (conn) => pgListSchemas(conn))
  }

  listTables(ns: Namespace): Promise<TableInfo[]> {
    return this.withConn(ns, (conn) => pgListTables(conn, ns))
  }

  listRoutines(ns: Namespace): Promise<RoutineInfo[]> {
    return this.withConn(ns, (conn) => pgListRoutines(conn, ns))
  }

  routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null> {
    return this.withConn(ns, (conn) => pgRoutineDefinition(conn, ns, name, kind))
  }

  listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]> {
    return this.withConn(ns, (conn) => pgListTriggers(conn, ns, table))
  }

  listEvents(_ns: Namespace): Promise<EventInfo[]> {
    // PostgreSQL has no built-in event scheduler.
    return Promise.resolve([])
  }

  listDependencies(ns: Namespace): Promise<ObjectDependency[] | null> {
    return this.withConn(ns, (conn) => pgListDependencies(conn, ns))
  }

  describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    return this.withConn(ns, (conn) => pgDescribeTable(conn, ns, table))
  }

  get serverNamespace(): Namespace {
    return { database: this.defaultDatabase() }
  }

  private serverNs(): Namespace {
    return this.serverNamespace
  }

  serverInfo(): Promise<ServerInfo> {
    return this.withConn(this.serverNs(), (conn) => pgServerInfo(conn))
  }

  listVariables(): Promise<KeyValue[]> {
    return this.withConn(this.serverNs(), (conn) => pgListVariables(conn))
  }

  listStatus(): Promise<KeyValue[]> {
    return this.withConn(this.serverNs(), (conn) => pgListStatus(conn))
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return this.withConn(this.serverNs(), (conn) => pgListProcesses(conn))
  }

  killProcess(id: string): Promise<void> {
    return this.withConn(this.serverNs(), (conn) => pgKillProcess(conn, id))
  }

  listUsers(): Promise<UserInfo[]> {
    return this.withConn(this.serverNs(), (conn) => pgListUsers(conn))
  }

  showGrants(user: UserRef, ns?: Namespace): Promise<string[]> {
    // Role attributes are cluster-wide, but schema/table ACLs live in the database being inspected.
    return this.withConn(ns ? { database: ns.database } : this.serverNs(), (conn) => pgShowGrants(conn, user))
  }

  /**
   * PostgreSQL has no SHOW CREATE TABLE; the DDL is reconstructed from the catalog (columns, defaults,
   * collations, identity options, PK, indexes, constraints as the server prints them, UNLOGGED, storage
   * parameters, INHERITS, PARTITION BY with the partitions, comments). Not covered: ownership/grants, policies,
   * tablespaces, user-defined types (a domain or composite type is not dumped, so a routine built on one cannot be
   * restored into an empty database).
   */
  showCreateTable(ns: Namespace, table: string, known?: TableSchema): Promise<string[]> {
    return this.withConn(ns, async (conn) => {
      const schema = known ?? (await pgDescribeTable(conn, ns, table))
      if (isViewKind(schema.kind)) {
        const t = quoteTable('postgres', ns, table)
        const r = firstResult(
          await conn.query(
            "SELECT pg_get_viewdef(c.oid, true), c.reloptions, obj_description(c.oid, 'pg_class') FROM pg_class c WHERE c.oid = $1::regclass",
            [t]
          )
        )
        const row = r.rows[0]
        const keyword = schema.kind === 'materialized_view' ? 'CREATE MATERIALIZED VIEW' : 'CREATE VIEW'
        // reloptions carry check_option / security_barrier / security_invoker (text[] arrives as its literal).
        const options = String(row?.[1] ?? '')
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0)
        const checkOption = options.find((o) => o.startsWith('check_option='))?.slice('check_option='.length)
        const withOptions = options.filter((o) => /^(security_barrier|security_invoker)=/.test(o))
        const withClause = withOptions.length > 0 ? ` WITH (${withOptions.join(', ')})` : ''
        const check = checkOption ? `\nWITH ${checkOption.toUpperCase()} CHECK OPTION` : ''
        // pg_get_viewdef ends with `;`, which must not sit between the body and the CHECK OPTION clause.
        const body = String(row?.[0] ?? '').replace(/;\s*$/, '')
        const out = [`${keyword} ${t}${withClause} AS\n${body}${check}`]
        const comment = row?.[2]
        if (typeof comment === 'string' && comment.length > 0) {
          out.push(
            `COMMENT ON ${schema.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'VIEW'} ${t} IS ${pgLiteral(comment)}`
          )
        }
        // A materialized view's indexes (REFRESH … CONCURRENTLY needs its unique index back).
        if (schema.kind === 'materialized_view') {
          const idx = firstResult(
            await conn.query(
              'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
              [ns.schema ?? 'public', table]
            )
          )
          for (const r of idx.rows) out.push(String(r[0] ?? ''))
        }
        return out
      }
      return pgCreateStatements(ns, schema, await pgTableCatalog(conn, quoteTable('postgres', ns, table)))
    })
  }

  toAdapterError(err: unknown): AdapterError {
    if (err instanceof AdapterError) return err
    const e = err as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown; position?: unknown }
    const code = typeof e.code === 'string' ? e.code : 'UNKNOWN'
    const message = typeof e.message === 'string' ? e.message : String(err)
    let kind: AdapterErrorCode = 'QUERY_FAILED'
    if (AUTH_CODES.has(code)) kind = 'AUTH_FAILED'
    else if (CONNECTION_CODES.has(code) || (code === 'UNKNOWN' && CONNECTION_MESSAGES.test(message)))
      kind = 'CONNECTION_FAILED'
    else if (PERMISSION_CODES.has(code)) kind = 'PERMISSION_DENIED'
    else if (NOT_FOUND_CODES.has(code)) kind = 'NOT_FOUND'
    const extra = [e.detail, e.hint].filter((x): x is string => typeof x === 'string' && x.length > 0)
    const detail = extra.length > 0 ? `${message} (${extra.join('; ')})` : message
    const position = Number(e.position)
    return new AdapterError(kind, `${code}: ${message}`, detail, {
      ...(code === 'UNKNOWN' ? {} : { nativeCode: code }),
      ...(Number.isInteger(position) && position > 0 ? { position } : {}),
    })
  }
}
