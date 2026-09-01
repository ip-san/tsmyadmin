import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { SqlConsole } from '@/features/sql/SqlConsole.tsx'
import { tablesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/sql')({ component: DatabaseSqlPage })

function DatabaseSqlPage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  const tables = useQuery(tablesQuery(db, schema))
  const completion: Record<string, string[]> = Object.fromEntries((tables.data ?? []).map((t) => [t.name, []]))
  return (
    <SqlConsole
      key={`${db}/${schema ?? ''}`}
      db={db}
      schema={schema}
      dialect={session.dialect}
      completion={completion}
    />
  )
}
