import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { MAX_HOPS } from '@/components/schema-diagram/neighbourhood.ts'
import { Designer } from '@/features/database/Designer.tsx'

export const Route = createFileRoute('/_app/db/$db/designer')({
  validateSearch: z.object({
    // A snapshot's id to compare with (from the Snapshots page): an id, never a row value.
    compare: z.string().max(100).optional().catch(undefined),
    // The table the diagram is drawn around, and how many keys out: a name, as in the sidebar's links.
    focus: z.string().max(256).optional().catch(undefined),
    hops: z.coerce.number().int().min(1).max(MAX_HOPS).optional().catch(undefined),
  }),
  component: Page,
})

function Page() {
  const { db } = Route.useParams()
  const { schema, compare, focus, hops } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  // Keyed by database: the saved layout is read once per database.
  return (
    <Designer
      key={`${db}.${schema ?? ''}`}
      db={db}
      schema={schema}
      compare={compare}
      focus={focus}
      hops={hops ?? 1}
      onFocus={(next, n) =>
        void navigate({ search: (prev) => ({ ...prev, focus: next, hops: next === undefined ? undefined : n }) })
      }
    />
  )
}
