import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { ProcessesPage } from '@/features/server/ProcessesPage.tsx'

export const Route = createFileRoute('/_app/processes')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs />
      <ProcessesPage />
    </>
  )
}
