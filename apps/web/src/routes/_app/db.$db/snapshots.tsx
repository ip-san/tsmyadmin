import { createFileRoute } from '@tanstack/react-router'
import { Snapshots } from '@/features/database/Snapshots.tsx'

export const Route = createFileRoute('/_app/db/$db/snapshots')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <Snapshots db={db} schema={schema} />
}
