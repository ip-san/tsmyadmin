import { createFileRoute } from '@tanstack/react-router'
import { DatabaseMap } from '@/features/database/DatabaseMap.tsx'

export const Route = createFileRoute('/_app/db/$db/map')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  // Keyed by database: the definitions read belong to the database they were for.
  return <DatabaseMap key={`${db}.${schema ?? ''}`} db={db} schema={schema} />
}
