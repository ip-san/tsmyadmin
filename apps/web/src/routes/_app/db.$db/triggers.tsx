import { createFileRoute } from '@tanstack/react-router'
import { TriggersPage } from '@/features/routines/TriggersPage.tsx'

export const Route = createFileRoute('/_app/db/$db/triggers')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <TriggersPage db={db} schema={schema} />
}
