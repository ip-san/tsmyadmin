import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { QUERY_TABLES_LIMIT } from '@/features/database/join-path.ts'
import { QueryBuilder } from '@/features/database/QueryBuilder.tsx'

export const Route = createFileRoute('/_app/db/$db/query')({
  validateSearch: z.object({
    // Tables to start with, in the order they are joined (a join path from the map): names, not values.
    tables: z.array(z.string().max(256)).max(QUERY_TABLES_LIMIT).optional().catch(undefined),
  }),
  component: Page,
})

function Page() {
  const { db } = Route.useParams()
  const { schema, tables } = Route.useSearch()
  // Keyed by database: the chosen tables and conditions belong to the database they were for.
  return (
    <QueryBuilder
      key={`${db}.${schema ?? ''}.${JSON.stringify(tables ?? [])}`}
      db={db}
      schema={schema}
      initialTables={tables}
    />
  )
}
