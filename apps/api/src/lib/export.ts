import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, ExportQuery, Namespace } from '@tsmyadmin/shared'
import { CSV_NULL, EXPORT_BATCH_SIZE, isBinaryCell } from '@tsmyadmin/shared'

export const DUMP_COMPLETE_MARKER = '-- tsmyadmin dump complete'

export interface ExportFile {
  /** Chunks are produced lazily so a large table never has to fit in memory at once. */
  body: AsyncIterable<string>
  contentType: string
  filename: string
}

function csvField(cell: Cell): string {
  if (cell === null) return CSV_NULL
  const text = isBinaryCell(cell) ? cell.$bin : typeof cell === 'string' ? cell : String(cell)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function* csvBody(adapter: DatabaseAdapter, ns: Namespace, table: string, bom: boolean): AsyncIterable<string> {
  if (bom) yield '﻿'
  let header = false
  for await (const b of adapter.iterateRows(ns, table, { batchSize: EXPORT_BATCH_SIZE })) {
    if (!header) {
      yield `${b.columns.map((c) => csvField(c.name)).join(',')}\r\n`
      header = true
    }
    if (b.rows.length > 0) yield `${b.rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`
  }
}

async function* jsonBody(adapter: DatabaseAdapter, ns: Namespace, tables: string[]): AsyncIterable<string> {
  yield '{\n'
  for (const [t, table] of tables.entries()) {
    yield `${t > 0 ? ',\n' : ''}  ${JSON.stringify(table)}: [`
    let first = true
    for await (const b of adapter.iterateRows(ns, table, { batchSize: EXPORT_BATCH_SIZE })) {
      for (const row of b.rows) {
        const obj = Object.fromEntries(b.columns.map((c, i) => [c.name, row[i] ?? null]))
        yield `${first ? '\n' : ',\n'}    ${JSON.stringify(obj)}`
        first = false
      }
    }
    yield first ? ']' : '\n  ]'
  }
  yield '\n}\n'
}

async function* sqlBody(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  q: ExportQuery
): AsyncIterable<string> {
  yield [
    '-- tsmyadmin SQL dump',
    `-- Dialect: ${adapter.dialect}`,
    `-- Database: ${ns.database}${ns.schema ? ` / schema ${ns.schema}` : ''}`,
    `-- Generated: ${new Date().toISOString()}`,
    '',
    '',
  ].join('\n')
  for (const table of tables) {
    yield `-- ----------------------------------------\n-- Table: ${table}\n-- ----------------------------------------\n\n`
    // One catalog round trip per table, shared by the DDL reconstruction and the row scan.
    const schema = await adapter.describeTable(ns, table)
    if (q.structure === '1') {
      for (const stmt of await adapter.showCreateTable(ns, table, schema)) yield `${stmt};\n\n`
    }
    if (q.data === '1') {
      for await (const b of adapter.iterateRows(ns, table, { batchSize: EXPORT_BATCH_SIZE, schema })) {
        const stmt = adapter.exporter.insert(
          ns,
          table,
          b.columns.map((c) => c.name),
          b.rows
        )
        if (stmt) yield `${stmt}\n\n`
      }
    }
  }
  // Terminal marker: a dump that lacks this line was cut short (the transfer is also aborted on errors).
  yield `${DUMP_COMPLETE_MARKER} (${tables.length} table${tables.length === 1 ? '' : 's'})\n`
}

/** Response body for a chunk stream. A failing chunk errors the stream (the client sees a failed transfer). */
export function toReadableStream(
  body: AsyncIterable<string>,
  onError?: (err: unknown) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = body[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<string>
      try {
        next = await iterator.next()
      } catch (err) {
        onError?.(err)
        throw err
      }
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/**
 * Builds a dump of `tables` in the requested format as a lazy chunk stream.
 * `baseName` is the file name without extension (db, or db_table when one table was requested explicitly).
 */
export function buildExport(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  q: ExportQuery,
  baseName: string = ns.database
): ExportFile {
  if (q.format === 'csv') {
    const table = tables[0]
    if (tables.length !== 1 || !table) throw new Error('CSV export needs exactly one table')
    return {
      body: csvBody(adapter, ns, table, q.bom === '1'),
      contentType: 'text/csv; charset=utf-8',
      filename: `${baseName}.csv`,
    }
  }
  if (q.format === 'json') {
    return {
      body: jsonBody(adapter, ns, tables),
      contentType: 'application/json; charset=utf-8',
      filename: `${baseName}.json`,
    }
  }
  return {
    body: sqlBody(adapter, ns, tables, q),
    contentType: 'application/sql; charset=utf-8',
    filename: `${baseName}.sql`,
  }
}

/** Collects a chunk stream into one string (tests, small exports). */
export async function collect(body: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of body) out += chunk
  return out
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback for non-Latin names. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7E]/g, '_').replaceAll('"', '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
