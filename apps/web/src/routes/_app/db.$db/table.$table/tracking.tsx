import { createFileRoute } from '@tanstack/react-router'
import { TrackingPage } from '@/features/tracking/TrackingPage.tsx'

export const Route = createFileRoute('/_app/db/$db/table/$table/tracking')({ component: Page })

function Page() {
  const { db, table } = Route.useParams()
  const { schema } = Route.useSearch()
  return <TrackingPage key={`${db}.${schema ?? ''}.${table}`} tableRef={{ db, schema, table }} />
}
