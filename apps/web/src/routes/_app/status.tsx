import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { StatusPage } from '@/features/server/StatusPage.tsx'

export const Route = createFileRoute('/_app/status')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs />
      <StatusPage />
    </>
  )
}
