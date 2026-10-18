import { createFileRoute } from '@tanstack/react-router'
import { TableOverview } from '@/features/structure/TableOverview.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/overview')({ component: OverviewPage })

function OverviewPage() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  // Keyed by table: what was read belongs to the table it was read for.
  return <TableOverview key={`${db}.${schema ?? ''}.${table}`} tableRef={{ db, schema, table }} />
}
