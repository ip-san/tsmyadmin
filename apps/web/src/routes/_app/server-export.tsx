import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { ServerExportForm } from '@/features/export/ServerExportForm.tsx'

export const Route = createFileRoute('/_app/server-export')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs tab={locale.tabs.export} />
      <ServerExportForm />
    </>
  )
}
