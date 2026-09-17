import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { TablePrivilegesPage } from '@/features/users/TablePrivilegesPage.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/privileges')({ component: Page })

function Page() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return <TablePrivilegesPage db={db} schema={schema} table={table} dialect={session.dialect} />
}
