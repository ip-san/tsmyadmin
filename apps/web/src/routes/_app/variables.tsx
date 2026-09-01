import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { VariablesPage } from '@/features/server/VariablesPage.tsx'

export const Route = createFileRoute('/_app/variables')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs />
      <VariablesPage />
    </>
  )
}
