import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { StructureView } from '@/features/structure/StructureView.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/structure')({ component: StructurePage })

function StructurePage() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return <StructureView tableRef={{ db, schema, table }} dialect={session.dialect} />
}
