import { createFileRoute } from '@tanstack/react-router'
import { ExportForm } from '@/features/export/ExportForm.tsx'

export const Route = createFileRoute('/_app/db/$db/export')({ component: DatabaseExportPage })

function DatabaseExportPage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <ExportForm db={db} schema={schema} />
}
