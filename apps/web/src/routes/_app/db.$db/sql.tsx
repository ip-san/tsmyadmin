import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { useMemo } from 'react'
import { SqlConsole } from '@/features/sql/SqlConsole.tsx'
import { tablesQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/db/$db/sql')({ component: DatabaseSqlPage })

function DatabaseSqlPage() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  const tables = useQuery(tablesQuery(db, schema))
  // Memoised: SqlEditor reconfigures the CodeMirror language (and its completion source) whenever this object changes.
  const completion = useMemo<Record<string, string[]>>(
    () => Object.fromEntries((tables.data ?? []).map((t) => [t.name, []])),
    [tables.data]
  )
  return (
    <SqlConsole
      key={`${db}/${schema ?? ''}`}
      db={db}
      schema={schema}
      dialect={session.dialect}
      completion={completion}
      draftId="db"
    />
  )
}
