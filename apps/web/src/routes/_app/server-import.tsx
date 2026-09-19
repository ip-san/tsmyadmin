import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { ImportForm } from '@/features/import/ImportForm.tsx'

export const Route = createFileRoute('/_app/server-import')({ component: Page })

function Page() {
  return (
    <>
      <ServerTabs tab={locale.tabs.import} />
      <ImportForm db={null} />
    </>
  )
}
