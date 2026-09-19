import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { CentralColumnsPage } from '@/features/database/CentralColumnsPage.tsx'

export const Route = createFileRoute('/_app/db/$db/central')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return <CentralColumnsPage key={`${db}.${schema ?? ''}`} db={db} schema={schema} dialect={session.dialect} />
}
