import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { CreateTableForm } from '@/features/database/CreateTableForm.tsx'
import { TablesList } from '@/features/database/TablesList.tsx'

export const Route = createFileRoute('/_app/db/$db/')({ component: DatabaseStructurePage })

function DatabaseStructurePage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <div className="space-y-8">
      <TablesList db={db} schema={schema} />
      <CreateTableForm db={db} schema={schema} dialect={session.dialect} />
    </div>
  )
}
