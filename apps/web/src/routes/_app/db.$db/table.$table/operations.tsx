import { createFileRoute } from '@tanstack/react-router'
import { TableOperations } from '@/features/operations/TableOperations.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/operations')({ component: Operations })

function Operations() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  return <TableOperations tableRef={{ db, schema, table }} />
}
