import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useRouteContext } from '@tanstack/react-router'
import { z } from 'zod'
import { locale } from '@/config/locale.ts'
import { CreateDatabaseForm } from '@/features/database/CreateDatabaseForm.tsx'
import { CreateTableForm } from '@/features/database/CreateTableForm.tsx'
import { CreateViewSection } from '@/features/database/CreateViewForm.tsx'
import { TablesList } from '@/features/database/TablesList.tsx'
import { tablesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/')({
  // `createView`: a SELECT handed over from a SQL result, to make a view of.
  validateSearch: z.object({ createView: z.string().max(100_000).optional().catch(undefined) }),
  component: DatabaseStructurePage,
})

function DatabaseStructurePage() {
  const { db } = Route.useParams()
  const { schema, createView } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  // A database that does not exist shows its error alone; live create forms there would be a dead end.
  const tables = useQuery(tablesQuery(db, schema))
  return (
    <div className="space-y-8">
      <TablesList db={db} schema={schema} />
      {tables.isError ? null : (
        <Link
          to="/db/$db/dictionary"
          params={{ db }}
          search={schema ? { schema } : {}}
          className="inline-block text-sm text-blue-700 underline dark:text-blue-300"
        >
          {locale.dictionary.link}
        </Link>
      )}
      {tables.isError ? null : (
        <>
          <CreateTableForm db={db} schema={schema} dialect={session.dialect} />
          <CreateViewSection db={db} schema={schema} initialSelect={createView} />
          {session.dialect === 'postgres' ? <CreateDatabaseForm database={db} kind="schema" /> : null}
        </>
      )}
    </div>
  )
}
