import type { ColumnMeta, Namespace, TableInfo, TableSchema, UserInfo, UserRef } from '@tsmyadmin/shared'
import pg, { type FieldDef, type PoolClient, type QueryResult } from 'pg'
import { BaseAdapter, type Conn, firstResult, type RawResult } from '../base.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type AdapterErrorCode, type ConnectionConfig } from '../types.ts'
import { pgCreateStatements, pgDdl } from './ddl.ts'
import { pgExporter } from './export.ts'
import { pgDescribeTable, pgListSchemas, pgListTables } from './introspect.ts'
import { pgListUsers, pgShowGrants, pgUsers } from './users.ts'
import { PG_TYPE_NAMES, pgToCell, pgTypes } from './values.ts'

const AUTH_CODES = new Set(['28P01', '28000'])
const NOT_FOUND_CODES = new Set(['3D000', '3F000', '42P01', '42703'])
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
    this.pools.set(database, pool)
    return pool
  }

  private async columnMetas(client: PoolClient, fields: FieldDef[]): Promise<ColumnMeta[]> {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID).filter((oid) => !this.typeNames.has(oid)))]
    if (unknown.length > 0) {
      const res = await client.query<{ oid: number; typname: string }>(
        'SELECT oid::int4 AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])',
        [unknown]
      )
      for (const row of res.rows) this.typeNames.set(Number(row.oid), row.typname)
    }
    return fields.map((f) => ({ name: f.name, dataType: this.typeNames.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` }))
  }

  private async toRaw(client: PoolClient, res: ArrayResult): Promise<RawResult> {
    const hasRows = res.fields.length > 0
    return {
      columns: hasRows ? await this.columnMetas(client, res.fields) : [],
      rows: hasRows ? res.rows.map((r) => r.map(pgToCell)) : [],
      affectedRows: res.rowCount ?? 0,
      hasRows,
    }
  }

  private async run(client: PoolClient, text: string, params?: unknown[]): Promise<RawResult | RawResult[]> {
    let res: ArrayResult | ArrayResult[]
    try {
      res = params
        ? await client.query<unknown[]>({ text, values: params, rowMode: 'array' })
        : ((await client.query<unknown[]>({ text, rowMode: 'array' })) as ArrayResult | ArrayResult[])
    } catch (err) {
      throw this.toAdapterError(err)
    }
    if (Array.isArray(res)) {
      const out: RawResult[] = []
      for (const r of res) out.push(await this.toRaw(client, r))
      return out
    }
    return this.toRaw(client, res)
  }

  protected async acquire(ns: Namespace): Promise<Conn> {
    let client: PoolClient
    try {
      client = await this.poolFor(ns.database).connect()
    } catch (err) {
      throw this.toAdapterError(err)
    }
    try {
      await this.run(client, `SET search_path TO ${quoteIdent('postgres', ns.schema ?? 'public')}`)
    } catch (err) {
      client.release()
      throw err
    }
    return { query: (text, params) => this.run(client, text, params), release: () => client.release() }
  }

  protected async setStatementTimeout(conn: Conn, ms: number): Promise<void> {
    await conn.query(`SET statement_timeout = ${Math.max(0, Math.floor(ms))}`)
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

  async listDatabases(): Promise<{ name: string }[]> {
    try {
      const res = await this.poolFor(this.defaultDatabase()).query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
      )
      return res.rows.map((r) => ({ name: r.datname }))
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

  describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    return this.withConn(ns, (conn) => pgDescribeTable(conn, ns, table))
  }

  listUsers(): Promise<UserInfo[]> {
    return this.withConn({ database: this.defaultDatabase() }, (conn) => pgListUsers(conn))
  }

  showGrants(user: UserRef): Promise<string[]> {
    return this.withConn({ database: this.defaultDatabase() }, (conn) => pgShowGrants(conn, user))
  }

  /**
   * PostgreSQL has no SHOW CREATE TABLE; the DDL is reconstructed from the catalog
   * (columns, defaults, identity, PK, indexes, foreign keys, comments). Not covered:
   * collations, storage parameters, partitioning, check constraints, ownership/grants.
   */
  showCreateTable(ns: Namespace, table: string): Promise<string[]> {
    return this.withConn(ns, async (conn) => {
      const schema = await pgDescribeTable(conn, ns, table)
      if (schema.kind === 'view') {
        const r = firstResult(
          await conn.query('SELECT pg_get_viewdef($1::regclass, true)', [quoteTable('postgres', ns, table)])
        )
        return [`CREATE VIEW ${quoteTable('postgres', ns, table)} AS\n${String(r.rows[0]?.[0] ?? '')}`]
      }
      return pgCreateStatements(ns, schema)
    })
  }

  toAdapterError(err: unknown): AdapterError {
    if (err instanceof AdapterError) return err
    const e = err as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown }
    const code = typeof e.code === 'string' ? e.code : 'UNKNOWN'
    const message = typeof e.message === 'string' ? e.message : String(err)
    let kind: AdapterErrorCode = 'QUERY_FAILED'
    if (AUTH_CODES.has(code)) kind = 'AUTH_FAILED'
    else if (CONNECTION_CODES.has(code)) kind = 'CONNECTION_FAILED'
    else if (NOT_FOUND_CODES.has(code)) kind = 'NOT_FOUND'
    const extra = [e.detail, e.hint].filter((x): x is string => typeof x === 'string' && x.length > 0)
    const detail = extra.length > 0 ? `${message} (${extra.join('; ')})` : message
    return new AdapterError(kind, `${code}: ${message}`, detail)
  }
}
