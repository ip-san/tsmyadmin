import type { ExportFormat } from '@tsmyadmin/shared'

export interface ExportOptions {
  db: string
  schema?: string | undefined
  tables: string[]
  format: ExportFormat
  structure: boolean
  data: boolean
  bom: boolean
}

/** URL of the download endpoint (a navigation, so cookies apply and the browser saves the file). */
export function exportUrl(o: ExportOptions): string {
  const params = new URLSearchParams()
  if (o.schema) params.set('schema', o.schema)
  if (o.tables.length > 0) params.set('tables', o.tables.join(','))
  params.set('format', o.format)
  params.set('structure', o.structure ? '1' : '0')
  params.set('data', o.data ? '1' : '0')
  params.set('bom', o.bom ? '1' : '0')
  return `/api/databases/${encodeURIComponent(o.db)}/export?${params.toString()}`
}
