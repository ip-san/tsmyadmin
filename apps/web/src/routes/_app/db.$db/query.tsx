import { createFileRoute } from '@tanstack/react-router'
import { QueryBuilder } from '@/features/database/QueryBuilder.tsx'

export const Route = createFileRoute('/_app/db/$db/query')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  // Keyed by database: the chosen tables and conditions belong to the database they were for.
  return <QueryBuilder key={`${db}.${schema ?? ''}`} db={db} schema={schema} />
}
