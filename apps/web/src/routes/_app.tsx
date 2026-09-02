import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useNavigate, useParams } from '@tanstack/react-router'
import { z } from 'zod'
import { AppShell } from '@/components/layout/AppShell.tsx'
import { DbTree } from '@/features/sidebar/DbTree.tsx'
import { mutations, sessionQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app')({
  validateSearch: z.object({ schema: z.string().optional() }),
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    // Deep links survive the login round trip; the top page needs no redirect param.
    if (!session) throw redirect({ to: '/login', search: location.href === '/' ? {} : { redirect: location.href } })
    return { session }
  },
  component: AppLayout,
})

function AppLayout() {
  const { session } = Route.useRouteContext()
  const params = useParams({ strict: false })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = async () => {
    await mutations.logout().catch(() => undefined)
    queryClient.clear()
    await navigate({ to: '/login' })
  }
  return (
    <AppShell session={session} sidebar={<DbTree dialect={session.dialect} activeDb={params.db} />} onLogout={logout}>
      <Outlet />
    </AppShell>
  )
}
