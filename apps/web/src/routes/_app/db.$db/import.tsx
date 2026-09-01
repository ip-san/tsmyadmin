import { createFileRoute } from '@tanstack/react-router'
import { ImportForm } from '@/features/import/ImportForm.tsx'

export const Route = createFileRoute('/_app/db/$db/import')({ component: DatabaseImportPage })

function DatabaseImportPage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <ImportForm db={db} schema={schema} />
}
