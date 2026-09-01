import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  ColumnMeta,
  Dialect,
  Filter,
  Namespace,
  RowKey,
  RowKeyKind,
  RowValues,
  StatementResult,
  TableInfo,
  TableSchema,
} from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { Params, quoteIdent, quoteTable } from './sql/quote.ts'
import { splitStatements } from './sql/split.ts'
import { AdapterError, type DatabaseAdapter, type DdlBuilder, type ExecuteOptions } from './types.ts'

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

  abstract ping(): Promise<void>
  abstract close(): Promise<void>
  abstract listDatabases(): Promise<{ name: string }[]>
  abstract listSchemas(database: string): Promise<string[]>
  abstract listTables(ns: Namespace): Promise<TableInfo[]>
  abstract describeTable(ns: Namespace, table: string): Promise<TableSchema>

  /** Checks a connection out of the pool for `ns` (MySQL: `USE db` applied; PG: pool of that database). */
  protected abstract acquire(ns: Namespace): Promise<Conn>
  /** Applies / clears a per-session statement timeout. 0 clears. */
  protected abstract setStatementTimeout(conn: Conn, ms: number): Promise<void>
  /** NULL-safe equality operator used for all-columns keys. */
  protected abstract nullSafeEq(): string
  /** Row-identity fallback when a table has no PK / NOT NULL unique key. */
  protected abstract fallbackKeyKind(): Extract<RowKeyKind, 'ctid' | 'all-columns'>
  /** Extra SELECT-list expression that exposes the fallback key (PG: ctid), or null. */
  protected abstract fallbackKeySelect(): string | null

  protected async withConn<T>(
    ns: Namespace,
    fn: (conn: Conn) => Promise<T>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const conn = await this.acquire(ns)
    try {
      await this.setStatementTimeout(conn, timeoutMs)
      return await fn(conn)
    } finally {
      try {
        await this.setStatementTimeout(conn, 0)
      } catch {
        // connection may already be broken; releasing is all we can do
      }
      conn.release()
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
    if (schema.kind === 'view') return { keyKind: 'none', keyColumns: [] }
    if (schema.primaryKey.length > 0) return { keyKind: 'pk', keyColumns: schema.primaryKey }
    const notNull = new Set(schema.columns.filter((c) => !c.nullable).map((c) => c.name))
    const unique = schema.indexes.find((i) => i.unique && i.columns.every((c) => notNull.has(c)))
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
      const count = firstResult(await conn.query(countSql, countParams.values))
      const totalCell = count.rows[0]?.[0]
      const total = typeof totalCell === 'number' ? totalCell : typeof totalCell === 'string' ? Number(totalCell) : null
      return {
        columns: data.columns,
        rows: data.rows,
        truncated: false,
        total: total !== null && Number.isFinite(total) ? total : null,
        keyKind: key.keyKind,
        keyColumns: key.keyColumns,
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

  async executeSql(ns: Namespace, script: string, opts: ExecuteOptions): Promise<StatementResult[]> {
    const statements = splitStatements(script, this.dialect)
    const results: StatementResult[] = []
    await this.withConn(
      ns,
      async (conn) => {
        for (const st of statements) {
          const started = performance.now()
          try {
            const raw = await conn.query(st.sql)
            const durationMs = Math.round(performance.now() - started)
            const list = Array.isArray(raw) ? raw : [raw]
            for (const r of list) {
              if (r.hasRows) {
                const truncated = r.rows.length > opts.maxRows
                results.push({
                  kind: 'rows',
                  sql: st.sql,
                  durationMs,
                  result: { columns: r.columns, rows: truncated ? r.rows.slice(0, opts.maxRows) : r.rows, truncated },
                })
              } else {
                results.push({ kind: 'affected', sql: st.sql, durationMs, affectedRows: r.affectedRows })
              }
            }
          } catch (err) {
            const e = err instanceof AdapterError ? err : this.toAdapterError(err)
            results.push({ kind: 'error', sql: st.sql, message: e.detail ?? e.message, code: e.code })
            if (opts.stopOnError) break
          }
        }
      },
      opts.timeoutMs
    )
    return results
  }

  /** Maps a driver error to AdapterError. */
  abstract toAdapterError(err: unknown): AdapterError
}
