import type { RowKey } from '@tsmyadmin/shared'

/** URL that downloads one value of one row whole (a navigation, so cookies apply and the browser saves the file). */
export function cellUrl(o: { db: string; schema?: string | undefined; table: string; key: RowKey; column: string }) {
  const params = new URLSearchParams()
  if (o.schema) params.set('schema', o.schema)
  params.set('column', o.column)
  params.set('key', JSON.stringify(o.key))
  return `/api/databases/${encodeURIComponent(o.db)}/tables/${encodeURIComponent(o.table)}/cell?${params.toString()}`
}
