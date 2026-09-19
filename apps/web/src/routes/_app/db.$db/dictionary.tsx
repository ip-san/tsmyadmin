import { createFileRoute } from '@tanstack/react-router'
import { DataDictionary } from '@/features/database/DataDictionary.tsx'

export const Route = createFileRoute('/_app/db/$db/dictionary')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  return <DataDictionary db={db} schema={schema} />
}
