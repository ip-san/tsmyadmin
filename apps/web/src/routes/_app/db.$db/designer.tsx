import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Designer } from '@/features/database/Designer.tsx'

export const Route = createFileRoute('/_app/db/$db/designer')({
  // A snapshot's id to compare with (from the Snapshots page): an id, never a row value.
  validateSearch: z.object({ compare: z.string().max(100).optional().catch(undefined) }),
  component: Page,
})

function Page() {
  const { db } = Route.useParams()
  const { schema, compare } = Route.useSearch()
  // Keyed by database: the saved layout is read once per database.
  return <Designer key={`${db}.${schema ?? ''}`} db={db} schema={schema} compare={compare} />
}
