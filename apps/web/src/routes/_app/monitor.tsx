import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { MonitorPage } from '@/features/server/MonitorPage.tsx'

export const Route = createFileRoute('/_app/monitor')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs tab={locale.tabs.monitor} />
      <MonitorPage />
    </>
  )
}
