import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useNavigate, useParams } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { AppShell } from '@/components/layout/AppShell.tsx'
import { Spinner } from '@/components/ui/Feedback.tsx'
import { DbTree } from '@/features/sidebar/DbTree.tsx'
import { mutations, sessionQuery } from '@/lib/queries.ts'

// Loaded when first opened: the editor is the largest thing the app ships, and most pages never need it.
const DockedConsole = lazy(() => import('@/features/sql/DockedConsole.tsx').then((m) => ({ default: m.DockedConsole })))

export const Route = createFileRoute('/_app')({
  validateSearch: z.object({ schema: z.string().optional() }),
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    // Deep links survive the login round trip; the top page needs no redirect param.
    if (!session) throw redirect({ to: '/login', search: location.href === '/' ? {} : { redirect: location.href } })
    // An account that must enrol can do nothing else: every other page would only show the API refusing it.
    if (session.secondFactor === 'enrollment_required' && location.pathname !== '/security') {
      throw redirect({ to: '/security' })
    }
    return { session }
  },
  component: AppLayout,
})

function AppLayout() {
  const { session: atLoad } = Route.useRouteContext()
  // The live copy: finishing the enrolment updates it, and with it whether the tree may be loaded.
  const session = useQuery(sessionQuery).data ?? atLoad
  const params = useParams({ strict: false })
  const { schema } = Route.useSearch()
  const dockDb = params.db ?? session.database ?? session.serverDatabase
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = async () => {
    await mutations.logout().catch(() => undefined)
    queryClient.clear()
    await navigate({ to: '/login' })
  }
  return (
    <AppShell
      session={session}
      sidebar={
        session.secondFactor === 'enrollment_required' ? null : (
          <DbTree dialect={session.dialect} activeDb={params.db} />
        )
      }
      dock={
        session.secondFactor === 'enrollment_required' ? undefined : (
          <Suspense fallback={<Spinner />}>
            <DockedConsole db={dockDb} schema={params.db ? schema : undefined} dialect={session.dialect} />
          </Suspense>
        )
      }
      onLogout={logout}
    >
      <Outlet />
    </AppShell>
  )
}
