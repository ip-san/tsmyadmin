import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { TriggersPage } from '@/features/routines/TriggersPage.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/triggers')({ component: Page })

function Page() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return <TriggersPage db={db} schema={schema} table={table} dialect={session.dialect} />
}
