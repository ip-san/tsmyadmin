import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { ServerCatalogPage } from '@/features/server/ServerCatalogPage.tsx'

export const Route = createFileRoute('/_app/engines')({ component: Page })

function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.catalog.titles.engines[session.dialect]} />
      <ServerCatalogPage kind="engines" dialect={session.dialect} />
    </>
  )
}
