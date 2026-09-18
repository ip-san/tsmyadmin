import { createFileRoute } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { SecondFactorPage } from '@/features/auth/SecondFactorPage.tsx'
import { useDocumentTitle } from '@/lib/document-title.ts'

export const Route = createFileRoute('/_app/security')({ component: Page })

function Page() {
  useDocumentTitle(locale.tabs.security)
  return (
    <>
      <ServerTabs tab={locale.tabs.security} />
      <SecondFactorPage />
    </>
  )
}
