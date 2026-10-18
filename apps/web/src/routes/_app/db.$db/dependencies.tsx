import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Dependencies } from '@/features/database/Dependencies.tsx'

export const Route = createFileRoute('/_app/db/$db/dependencies')({
  // The table or view to start from (a node's id: its kind and name), as the structure's card links to it.
  validateSearch: z.object({ focus: z.string().max(600).optional().catch(undefined) }),
  component: Page,
})

function Page() {
  const { db } = Route.useParams()
  const { schema, focus } = Route.useSearch()
  // Keyed by database and start: the choice belongs to the database, and a new start is a new page.
  return <Dependencies key={`${db}.${schema ?? ''}.${focus ?? ''}`} db={db} schema={schema} focus={focus} />
}
