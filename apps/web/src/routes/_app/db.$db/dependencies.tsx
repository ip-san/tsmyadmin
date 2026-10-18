import { createFileRoute } from '@tanstack/react-router'
import { Dependencies } from '@/features/database/Dependencies.tsx'

export const Route = createFileRoute('/_app/db/$db/dependencies')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  // Keyed by database: the table chosen belongs to the database it was chosen in.
  return <Dependencies key={`${db}.${schema ?? ''}`} db={db} schema={schema} />
}
