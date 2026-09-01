import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { locale } from '@/config/locale.ts'

/** Server-level tab bar (phpMyAdmin: Databases / SQL / Status / Users / Variables / Processes). */
export function ServerTabs() {
  return (
    <>
      <PageTitle>{locale.server.title}</PageTitle>
      <TabNav
        label={locale.nav.server}
        items={[
          { label: locale.tabs.databases, to: '/', exact: true },
          { label: locale.tabs.status, to: '/status' },
          { label: locale.tabs.variables, to: '/variables' },
          { label: locale.tabs.processes, to: '/processes' },
          { label: locale.tabs.users, to: '/users' },
        ]}
      />
    </>
  )
}
