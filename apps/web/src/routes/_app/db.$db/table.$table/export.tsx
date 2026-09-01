import { createFileRoute } from '@tanstack/react-router'
import { ExportForm } from '@/features/export/ExportForm.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/export')({ component: TableExportPage })

function TableExportPage() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  return <ExportForm db={db} schema={schema} table={table} />
}
