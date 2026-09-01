import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, ExportQuery, Namespace } from '@tsmyadmin/shared'
import { CSV_NULL, EXPORT_BATCH_SIZE, isBinaryCell } from '@tsmyadmin/shared'

export interface ExportFile {
  body: string
  contentType: string
  filename: string
}

function csvField(cell: Cell): string {
  if (cell === null) return CSV_NULL
  const text = isBinaryCell(cell) ? cell.$bin : typeof cell === 'string' ? cell : String(cell)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Builds a dump of `tables` in the requested format. Whole document in memory (batched reads keep the DB side bounded). */
/** `baseName` is the file name without extension (db, or db_table when one table was requested explicitly). */
export async function buildExport(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  q: ExportQuery,
  baseName: string = ns.database
): Promise<ExportFile> {
  const base = baseName
  const batch = { batchSize: EXPORT_BATCH_SIZE }

  if (q.format === 'csv') {
    const table = tables[0]
    if (tables.length !== 1 || !table) throw new Error('CSV export needs exactly one table')
    const lines: string[] = []
    let header = false
    for await (const b of adapter.iterateRows(ns, table, batch)) {
      if (!header) {
        lines.push(b.columns.map((c) => csvField(c.name)).join(','))
        header = true
      }
      for (const row of b.rows) lines.push(row.map(csvField).join(','))
    }
    const body = `${q.bom === '1' ? '﻿' : ''}${lines.join('\r\n')}\r\n`
    return { body, contentType: 'text/csv; charset=utf-8', filename: `${base}.csv` }
  }

  if (q.format === 'json') {
    const out: Record<string, Record<string, unknown>[]> = {}
    for (const table of tables) {
      const rows: Record<string, unknown>[] = []
      for await (const b of adapter.iterateRows(ns, table, batch)) {
        for (const row of b.rows) rows.push(Object.fromEntries(b.columns.map((c, i) => [c.name, row[i] ?? null])))
      }
      out[table] = rows
    }
    return {
      body: `${JSON.stringify(out, null, 2)}\n`,
      contentType: 'application/json; charset=utf-8',
      filename: `${base}.json`,
    }
  }

  const parts: string[] = [
    `-- tsmyadmin SQL dump`,
    `-- Dialect: ${adapter.dialect}`,
    `-- Database: ${ns.database}${ns.schema ? ` / schema ${ns.schema}` : ''}`,
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ]
  for (const table of tables) {
    parts.push(
      `-- ----------------------------------------`,
      `-- Table: ${table}`,
      `-- ----------------------------------------`,
      ''
    )
    // One catalog round trip per table, shared by the DDL reconstruction and the row scan.
    const schema = await adapter.describeTable(ns, table)
    if (q.structure === '1') {
      for (const stmt of await adapter.showCreateTable(ns, table, schema)) parts.push(`${stmt};`, '')
    }
    if (q.data === '1') {
      for await (const b of adapter.iterateRows(ns, table, { ...batch, schema })) {
        const stmt = adapter.exporter.insert(
          ns,
          table,
          b.columns.map((c) => c.name),
          b.rows
        )
        if (stmt) parts.push(stmt, '')
      }
    }
  }
  return { body: `${parts.join('\n')}\n`, contentType: 'application/sql; charset=utf-8', filename: `${base}.sql` }
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback for non-Latin names. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7E]/g, '_').replaceAll('"', '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
