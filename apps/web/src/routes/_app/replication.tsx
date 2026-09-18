import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { ReplicationPage } from '@/features/server/ReplicationPage.tsx'

export const Route = createFileRoute('/_app/replication')({ component: Page })

function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.replication.title} />
      <ReplicationPage dialect={session.dialect} />
    </>
  )
}
