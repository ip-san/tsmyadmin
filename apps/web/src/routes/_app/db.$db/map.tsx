import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { DatabaseMap } from '@/features/database/DatabaseMap.tsx'

export const Route = createFileRoute('/_app/db/$db/map')({
  validateSearch: z.object({
    // The two tables a join path is asked between: names, as in the sidebar's links.
    from: z.string().max(256).optional().catch(undefined),
    to: z.string().max(256).optional().catch(undefined),
  }),
  component: Page,
})

function Page() {
  const { db } = Route.useParams()
  const { schema, from, to } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  // Keyed by database: the definitions read belong to the database they were for.
  return (
    <DatabaseMap
      key={`${db}.${schema ?? ''}`}
      db={db}
      schema={schema}
      ends={{ from, to: to === from ? undefined : to }}
      // In place: trying two tables is one visit, not one step back each.
      onEnds={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })}
    />
  )
}
