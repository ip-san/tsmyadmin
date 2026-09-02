import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { StatusPage } from '@/features/server/StatusPage.tsx'

export const Route = createFileRoute('/_app/status')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs tab={locale.tabs.status} />
      <StatusPage />
    </>
  )
}
