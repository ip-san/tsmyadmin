import { createFileRoute } from '@tanstack/react-router'
import { DatabaseSearch } from '@/features/database/DatabaseSearch.tsx'

export const Route = createFileRoute('/_app/db/$db/search')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  // Keyed by database: the terms, the table selection and the results belong to the database they were for.
  return <DatabaseSearch key={`${db}.${schema ?? ''}`} db={db} schema={schema} />
}
