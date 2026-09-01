import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { PrivilegesPage } from '@/features/users/PrivilegesPage.tsx'

export const Route = createFileRoute('/_app/db/$db/privileges')({ component: DatabasePrivilegesPage })

function DatabasePrivilegesPage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return <PrivilegesPage db={db} schema={schema} dialect={session.dialect} />
}
