import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { UserGroupsPage } from '@/features/users/UserGroupsPage.tsx'

export const Route = createFileRoute('/_app/user-groups')({ component: Page })

function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.tabs.userGroups} />
      <UserGroupsPage dialect={session.dialect} />
    </>
  )
}
