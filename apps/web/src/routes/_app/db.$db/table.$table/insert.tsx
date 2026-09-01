import { createFileRoute } from '@tanstack/react-router'
import { InsertPage } from '@/features/rows/InsertPage.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/insert')({ component: Insert })

function Insert() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  return <InsertPage tableRef={{ db, schema, table }} />
}
