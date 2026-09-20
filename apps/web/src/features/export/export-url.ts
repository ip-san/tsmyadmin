import { type ExportOptions, encodeTableList } from '@tsmyadmin/shared'

/** One export: which namespace and tables, plus the choices a template stores. */
export interface ExportTarget extends ExportOptions {
  db: string
  schema?: string | undefined
  tables: string[]
}

const flag = (on: boolean) => (on ? '1' : '0')

/** URL of the download endpoint (a navigation, so cookies apply and the browser saves the file). */
export function exportUrl(o: ExportTarget): string {
  const params = new URLSearchParams()
  if (o.schema) params.set('schema', o.schema)
  if (o.tables.length > 0) params.set('tables', encodeTableList(o.tables))
  addOptions(params, o)
  return `/api/databases/${encodeURIComponent(o.db)}/export?${params.toString()}`
}

/** URL of the server-level dump: the databases (MySQL) or schemas (PostgreSQL) named, always as SQL. */
export function serverExportUrl(targets: string[], o: ExportOptions): string {
  const params = new URLSearchParams({ targets: encodeTableList(targets) })
  addOptions(params, { ...o, format: 'sql' })
  return `/api/server/export?${params.toString()}`
}

function addOptions(params: URLSearchParams, o: ExportOptions): void {
  params.set('format', o.format)
  params.set('structure', flag(o.structure))
  params.set('dropTable', flag(o.dropTable))
  params.set('data', flag(o.data))
  params.set('bom', flag(o.bom))
  params.set('csvSafe', flag(o.csvSafe))
  params.set('csvDelimiter', o.csvDelimiter)
  params.set('csvHeader', flag(o.csvHeader))
  params.set('csvQuoteAll', flag(o.csvQuoteAll))
  params.set('csvStripEol', flag(o.csvStripEol))
  params.set('jsonCompact', flag(o.jsonCompact))
  params.set('xmlViews', flag(o.xmlViews))
  params.set('xmlRoutines', flag(o.xmlRoutines))
  params.set('xmlTriggers', flag(o.xmlTriggers))
  params.set('latexCaption', flag(o.latexCaption))
  params.set('latexLabel', flag(o.latexLabel))
  if (o.odsNull !== '') params.set('odsNull', o.odsNull)
  params.set('routines', flag(o.routines))
  params.set('stripDefiner', flag(o.stripDefiner))
  params.set('compress', o.compress)
  params.set('filePerTable', flag(o.filePerTable))
  if (o.filename.trim()) params.set('filename', o.filename.trim())
  params.set('charset', o.charset)
  params.set('statement', o.statement)
  params.set('columnNames', flag(o.columnNames))
  params.set('extended', flag(o.extended))
  params.set('maxQuery', String(o.maxQuery))
  params.set('ignore', flag(o.ignore))
  params.set('utc', flag(o.utc))
  params.set('transaction', flag(o.transaction))
  params.set('viewsAsTables', flag(o.viewsAsTables))
  params.set('createDatabase', flag(o.createDatabase))
  params.set('ifNotExists', flag(o.ifNotExists))
  params.set('comments', flag(o.comments))
  params.set('lockTables', flag(o.lockTables))
  params.set('rowOffset', String(o.rowOffset))
  params.set('rowLimit', String(o.rowLimit))
}
