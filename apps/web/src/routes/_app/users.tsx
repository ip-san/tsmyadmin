import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { UsersPage } from '@/features/users/UsersPage.tsx'

export const Route = createFileRoute('/_app/users')({ component: ServerUsersPage })

function ServerUsersPage() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.tabs.users} />
      <UsersPage dialect={session.dialect} />
    </>
  )
}
