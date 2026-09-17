import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { DatabaseOperations } from '@/features/database/DatabaseOperations.tsx'

export const Route = createFileRoute('/_app/db/$db/operations')({ component: Operations })

function Operations() {
  const { db } = Route.useParams()
  const { session } = useRouteContext({ from: '/_app' })
  return <DatabaseOperations db={db} dialect={session.dialect} serverDatabase={session.serverDatabase} />
}
