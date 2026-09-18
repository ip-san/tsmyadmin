import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { ServerCatalogPage } from '@/features/server/ServerCatalogPage.tsx'

export const Route = createFileRoute('/_app/plugins')({ component: Page })

function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.catalog.titles.plugins[session.dialect]} />
      <ServerCatalogPage kind="plugins" dialect={session.dialect} />
    </>
  )
}
