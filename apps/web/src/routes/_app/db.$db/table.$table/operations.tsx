import { createFileRoute } from '@tanstack/react-router'
import { CopyTableForm } from '@/features/operations/CopyTableForm.tsx'
import { RenameTableForm } from '@/features/operations/RenameTableForm.tsx'
import { TableOperations } from '@/features/operations/TableOperations.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/operations')({ component: Operations })

function Operations() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  return (
    <div className="space-y-4">
      <RenameTableForm tableRef={{ db, schema, table }} />
      <CopyTableForm tableRef={{ db, schema, table }} />
      <TableOperations tableRef={{ db, schema, table }} />
    </div>
  )
}
