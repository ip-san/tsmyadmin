import { createFileRoute } from '@tanstack/react-router'
import { ImportForm } from '@/features/import/ImportForm.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/import')({ component: TableImportPage })

function TableImportPage() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  return <ImportForm db={db} schema={schema} table={table} />
}
