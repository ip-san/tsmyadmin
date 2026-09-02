import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { EventsPage } from '@/features/routines/EventsPage.tsx'

export const Route = createFileRoute('/_app/db/$db/events')({ component: Page })

function Page() {
  const { db } = Route.useParams()
  const { schema } = Route.useSearch()
  const { session } = useRouteContext({ from: '/_app' })
  return <EventsPage db={db} schema={schema} dialect={session.dialect} />
}
