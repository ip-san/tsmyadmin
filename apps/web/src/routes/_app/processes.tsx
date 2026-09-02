import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { ProcessesPage } from '@/features/server/ProcessesPage.tsx'

export const Route = createFileRoute('/_app/processes')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs tab={locale.tabs.processes} />
      <ProcessesPage />
    </>
  )
}
