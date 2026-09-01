import { createFileRoute } from '@tanstack/react-router'
import { TablesList } from '@/features/database/TablesList.tsx'

export const Route = createFileRoute('/_app/db/$db/')({ component: DatabaseStructurePage })

function DatabaseStructurePage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <TablesList db={db} schema={schema} />
}
