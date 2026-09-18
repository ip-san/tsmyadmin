import { type ExportOptions, encodeTableList } from '@tsmyadmin/shared'

/** One export: which namespace and tables, plus the choices a template stores. */
export interface ExportTarget extends ExportOptions {
  db: string
  schema?: string | undefined
  tables: string[]
}

/** URL of the download endpoint (a navigation, so cookies apply and the browser saves the file). */
export function exportUrl(o: ExportTarget): string {
  const params = new URLSearchParams()
  if (o.schema) params.set('schema', o.schema)
  if (o.tables.length > 0) params.set('tables', encodeTableList(o.tables))
  params.set('format', o.format)
  params.set('structure', o.structure ? '1' : '0')
  params.set('dropTable', o.dropTable ? '1' : '0')
  params.set('data', o.data ? '1' : '0')
  params.set('bom', o.bom ? '1' : '0')
  params.set('csvSafe', o.csvSafe ? '1' : '0')
  params.set('routines', o.routines ? '1' : '0')
  params.set('stripDefiner', o.stripDefiner ? '1' : '0')
  return `/api/databases/${encodeURIComponent(o.db)}/export?${params.toString()}`
}
