import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { isViewKind } from '@tsmyadmin/shared'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { CopyTableForm } from '@/features/operations/CopyTableForm.tsx'
import { MaintenanceActions } from '@/features/operations/MaintenanceActions.tsx'
import { RenameTableForm } from '@/features/operations/RenameTableForm.tsx'
import { TableOperations } from '@/features/operations/TableOperations.tsx'
import { TableOptionsForm } from '@/features/operations/TableOptionsForm.tsx'
import { structureQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table/operations')({ component: Operations })

function Operations() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  const tableRef = { db, schema, table }
  // The kind decides which operations apply: views cannot be truncated or copied with CREATE TABLE ... LIKE.
  const structure = useQuery(structureQuery(tableRef))
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  const view = isViewKind(structure.data.kind)
  return (
    <div className="space-y-4">
      {/* Keyed by table: the route match is reused across tables, and the forms seed their state from the name. */}
      <RenameTableForm key={table} tableRef={tableRef} view={view} sequence={structure.data.kind === 'sequence'} />
      {view ? null : (
        <TableOptionsForm
          key={`${table}-options`}
          tableRef={tableRef}
          dialect={session.dialect}
          schema={structure.data}
        />
      )}
      {view ? null : <CopyTableForm key={table} tableRef={tableRef} />}
      {view ? null : <MaintenanceActions tableRef={tableRef} dialect={session.dialect} />}
      <TableOperations tableRef={tableRef} kind={structure.data.kind} />
    </div>
  )
}
