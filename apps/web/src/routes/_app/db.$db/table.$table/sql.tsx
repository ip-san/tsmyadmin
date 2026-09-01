import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { selectAllPrefill } from '@/features/sql/prefill.ts'
import { SqlConsole } from '@/features/sql/SqlConsole.tsx'
import { structureQuery, tablesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table/sql')({ component: TableSqlPage })

function TableSqlPage() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  const tables = useQuery(tablesQuery(db, schema))
  const structure = useQuery(structureQuery({ db, schema, table }))
  const completion: Record<string, string[]> = Object.fromEntries((tables.data ?? []).map((t) => [t.name, []]))
  if (structure.data) completion[table] = structure.data.columns.map((c) => c.name)
  return (
    <SqlConsole
      key={`${db}/${schema ?? ''}/${table}`}
      db={db}
      schema={schema}
      dialect={session.dialect}
      initialSql={selectAllPrefill(session.dialect, table, schema)}
      completion={completion}
    />
  )
}
