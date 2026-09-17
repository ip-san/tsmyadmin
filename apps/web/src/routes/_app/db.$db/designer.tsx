import { createFileRoute } from '@tanstack/react-router'
import { Designer } from '@/features/database/Designer.tsx'

export const Route = createFileRoute('/_app/db/$db/designer')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  // Keyed by database: the saved layout is read once per database.
  return <Designer key={`${db}.${schema ?? ''}`} db={db} schema={schema} />
}
