import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { CreateDatabaseForm } from '@/features/database/CreateDatabaseForm.tsx'
import { CreateTableForm } from '@/features/database/CreateTableForm.tsx'
import { TablesList } from '@/features/database/TablesList.tsx'
import { tablesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/')({ component: DatabaseStructurePage })

function DatabaseStructurePage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  // A database that does not exist shows its error alone; live create forms there would be a dead end.
  const tables = useQuery(tablesQuery(db, schema))
  return (
    <div className="space-y-8">
      <TablesList db={db} schema={schema} />
      {tables.isError ? null : (
        <>
          <CreateTableForm db={db} schema={schema} dialect={session.dialect} />
          {session.dialect === 'postgres' ? <CreateDatabaseForm database={db} kind="schema" /> : null}
        </>
      )}
    </div>
  )
}
