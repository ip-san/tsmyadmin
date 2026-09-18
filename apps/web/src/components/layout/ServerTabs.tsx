import { useQuery } from '@tanstack/react-query'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { locale } from '@/config/locale.ts'
import { useDocumentTitle } from '@/lib/document-title.ts'
import { sessionQuery } from '@/lib/queries.ts'

/** Server-level tab bar (phpMyAdmin: Databases / SQL / Status / Users / Variables / Processes). */
export function ServerTabs({ tab }: { tab: string }) {
  useDocumentTitle(tab, locale.server.title)
  // Already loaded by the layout's guard; the second factor needs a persistent store, so the tab follows it.
  const secondFactor = useQuery(sessionQuery).data?.secondFactor ?? 'unsupported'
  return (
    <>
      <PageTitle>{locale.server.title}</PageTitle>
      <TabNav
        label={locale.nav.server}
        items={[
          { label: locale.tabs.databases, to: '/', exact: true },
          { label: locale.tabs.sql, to: '/sql' },
          { label: locale.tabs.status, to: '/status' },
          { label: locale.tabs.variables, to: '/variables' },
          { label: locale.tabs.processes, to: '/processes' },
          { label: locale.tabs.users, to: '/users' },
          { label: locale.tabs.security, to: '/security', hidden: secondFactor === 'unsupported' },
        ]}
      />
    </>
  )
}
