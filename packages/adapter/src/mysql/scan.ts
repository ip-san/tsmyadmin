/** Reading a whole MySQL / MariaDB table: keyset pages over its key, or one streamed SELECT where it has none. */
import type { Cell, ColumnMeta, Namespace, RowKeyKind, TableSchema } from '@tsmyadmin/shared'
import type { Connection as CoreConnection } from 'mysql2'
import type { FieldPacket, PoolConnection } from 'mysql2/promise'
import { type Conn, firstResult, type RawResult } from '../driver.ts'
import { driverValueToCell, type QueryOptions, toDbValue, UNCAPPED } from '../sql/cells.ts'
import { Params, quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type RowBatch } from '../types.ts'
import { keyColumnExpr, keyParam } from './key-types.ts'
import { mysqlColumnMeta } from './values.ts'

/**
 * Row-at-a-time read of one SELECT through mysql2's stream API (rows are converted as they arrive; the stream
 * pauses the socket when the consumer is slower). A consumer that stops early leaves the query half-read on
 * the wire, so the connection is discarded rather than returned to the pool: `abandon` marks it, and `fail` maps
 * an error (marking the connection when the error is a lost one).
 */
export async function* mysqlStreamRows(
  conn: PoolConnection,
  text: string,
  params: unknown[],
  batchSize: number,
  options: QueryOptions | undefined,
  fail: (err: unknown) => Error,
  abandon: () => void
): AsyncIterable<RawResult> {
  // The promise wrapper's typings call the inner connection a promise Connection; at runtime it is the core
  // callback one, which is the only API with a row stream.
  const core = conn.connection as unknown as CoreConnection
  // mysql2 only reports a lost connection to commands with a callback; a callback would make it buffer every
  // row, so the connection's own 'error' (KILL, server gone, net_write_timeout on a stalled client) is forwarded
  // to the stream instead — otherwise the iteration would wait forever. Listening before the query is queued
  // covers a connection the server closed a moment ago (mysql2 emits that synchronously).
  let stream: ReturnType<ReturnType<CoreConnection['query']>['stream']> | null = null
  let pending: Error | null = null
  const onFatal = (err: Error) => {
    if (stream) stream.destroy(err)
    else pending = err
  }
  core.on('error', onFatal)
  let columns: ColumnMeta[] = []
  let rows: Cell[][] = []
  let finished = false
  try {
    const query = core.query({ sql: text, values: params, rowsAsArray: true })
    query.on('fields', (fields: FieldPacket[]) => {
      columns = fields.map(mysqlColumnMeta)
    })
    stream = query.stream({ highWaterMark: batchSize })
    if (pending) stream.destroy(pending)
    for await (const row of stream) {
      rows.push((row as unknown[]).map((v) => driverValueToCell(v, options)))
      if (rows.length >= batchSize) {
        yield { columns, rows, affectedRows: 0, hasRows: true }
        rows = []
      }
    }
    finished = true
  } catch (err) {
    finished = true
    throw fail(err)
  } finally {
    core.off('error', onFatal)
    if (!finished) {
      // Abandoned mid-scan: drop the socket outright, or the rest of the result set keeps arriving and being
      // parsed until the server notices the half-closed connection.
      stream?.destroy()
      abandon()
      ;(core as unknown as { stream?: { destroy(): void } }).stream?.destroy()
    }
  }
  // The last (possibly empty) batch also tells an empty table's caller the column list.
  yield { columns, rows, affectedRows: 0, hasRows: true }
}

/** What a scan of one table reads and in what order, worked out before a connection is borrowed. */
export interface ScanPlan {
  columns: string[]
  tableSql: string
  keyIndexes: number[]
  keyTypes: string[]
  keyExprs: string[]
  orderBy: string
  single: boolean
  batchSize: number
}

/** The plan of a scan; a key column the schema does not list is refused before anything is read. */
export function mysqlScanPlan(
  ns: Namespace,
  table: string,
  schema: TableSchema,
  key: { keyKind: RowKeyKind; keyColumns: string[] },
  batchSize: number
): ScanPlan {
  const columns = schema.columns.map((c) => quoteIdent('mysql', c.name))
  const tableSql = quoteTable('mysql', ns, table)
  // Position of each key column in the selected row.
  const keyIndexes =
    key.keyKind === 'pk' ? key.keyColumns.map((c) => schema.columns.findIndex((col) => col.name === c)) : []
  if (keyIndexes.includes(-1)) throw new AdapterError('QUERY_FAILED', 'Key column missing from table schema')
  const keyTypes = keyIndexes.map((i) => schema.columns[i]?.dataType ?? '')
  const keyExprs =
    key.keyKind === 'pk' ? key.keyColumns.map((c, i) => keyColumnExpr(quoteIdent('mysql', c), keyTypes[i] ?? '')) : []
  const orderBy = keyExprs.length > 0 ? ` ORDER BY ${keyExprs.join(', ')}` : ''
  return {
    columns,
    tableSql,
    keyIndexes,
    keyTypes,
    keyExprs,
    orderBy,
    single: orderBy === '',
    batchSize: Math.max(1, Math.floor(batchSize)),
  }
}

/**
 * The batches of a scan on a borrowed connection. With `utc`, times are read as UTC (for a dump restored under a
 * session that reads them so); the caller resets the session afterwards, since the setting would outlive the scan.
 */
export async function* mysqlScanRows(conn: Conn, plan: ScanPlan, utc: boolean): AsyncIterable<RowBatch> {
  const { columns, tableSql, keyIndexes, keyTypes, keyExprs, orderBy, single, batchSize } = plan
  if (utc) await conn.query("SET SESSION time_zone = '+00:00'")
  if (single && conn.stream) {
    // Streamed rows arrive one at a time, so a key-less table of any size costs one batch of memory.
    const sql = `SELECT ${columns.join(', ')} FROM ${tableSql}`
    for await (const r of conn.stream(sql, [], batchSize, UNCAPPED)) yield { columns: r.columns, rows: r.rows }
    return
  }
  let last: Cell[] | null = null
  let first = true
  for (;;) {
    const params = new Params('mysql')
    let where = ''
    if (last) {
      const lastRow = last
      const lastKey = keyIndexes.map((i, k) => keyParam(params.add(toDbValue(lastRow[i] ?? null)), keyTypes[k] ?? ''))
      where = ` WHERE (${keyExprs.join(', ')}) > (${lastKey.join(', ')})`
    }
    const limit = single ? '' : ` LIMIT ${params.add(batchSize)}`
    // Exports must carry whole binaries; the display cap only applies to browsing.
    const r = firstResult(
      await conn.query(
        `SELECT ${columns.join(', ')} FROM ${tableSql}${where}${orderBy}${limit}`,
        params.values,
        UNCAPPED
      )
    )
    // An empty table still yields one batch so callers learn the column list.
    if (r.rows.length > 0 || first) yield { columns: r.columns, rows: r.rows }
    first = false
    if (single || r.rows.length < batchSize) return
    last = r.rows[r.rows.length - 1] ?? null
  }
}
