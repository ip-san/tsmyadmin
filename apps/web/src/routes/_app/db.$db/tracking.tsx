import { createFileRoute } from '@tanstack/react-router'
import { DatabaseTracking } from '@/features/tracking/DatabaseTracking.tsx'

export const Route = createFileRoute('/_app/db/$db/tracking')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <DatabaseTracking db={db} schema={schema} />
}
