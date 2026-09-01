import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { PageTitle } from '@/components/layout/PageTitle.tsx'
import { TabNav } from '@/components/layout/TabNav.tsx'
import { locale } from '@/config/locale.ts'
import { UsersPage } from '@/features/users/UsersPage.tsx'

export const Route = createFileRoute('/_app/users')({ component: ServerUsersPage })

function ServerUsersPage() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <PageTitle>{locale.server.title}</PageTitle>
      <TabNav
        label={locale.nav.server}
        items={[
          { label: locale.tabs.databases, to: '/', exact: true },
          { label: locale.tabs.users, to: '/users' },
        ]}
      />
      <UsersPage dialect={session.dialect} />
    </>
  )
}
