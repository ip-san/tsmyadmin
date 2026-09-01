import { createFileRoute } from '@tanstack/react-router'
import { RoutinesPage } from '@/features/routines/RoutinesPage.tsx'

export const Route = createFileRoute('/_app/db/$db/routines')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <RoutinesPage db={db} schema={schema} />
}
