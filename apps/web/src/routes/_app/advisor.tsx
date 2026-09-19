import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { AdvisorPage } from '@/features/server/AdvisorPage.tsx'

export const Route = createFileRoute('/_app/advisor')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs tab={locale.tabs.advisor} />
      <AdvisorPage />
    </>
  )
}
