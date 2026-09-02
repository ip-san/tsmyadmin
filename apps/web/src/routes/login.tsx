import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { LoginForm } from '@/features/auth/LoginForm.tsx'
import { useDocumentTitle } from '@/lib/document-title.ts'
import { mutations, serversQuery, sessionQuery } from '@/lib/queries.ts'
import { safeRedirect } from '@/lib/redirect.ts'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional(), expired: z.boolean().optional() }),
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (session) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: LoginPage,
})

function LoginPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const search = Route.useSearch()
  const servers = useQuery(serversQuery)
  useDocumentTitle(locale.login.title)
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <h1 className="mb-1 text-xl font-bold text-zinc-900 dark:text-zinc-50">{locale.app.name}</h1>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{locale.login.title}</p>
        {search.expired ? <Notice className="mb-4">{locale.login.sessionExpired}</Notice> : null}
        {servers.isPending ? (
          <Spinner />
        ) : (
          <LoginForm
            presets={servers.data ?? []}
            onLogin={async (body) => {
              const info = await mutations.login(body)
              // ensureQueryData() in route guards returns cached data as-is, so write the new session directly.
              queryClient.setQueryData(sessionQuery.queryKey, info)
              await navigate({ href: safeRedirect(search.redirect) })
            }}
          />
        )}
        <p className="mt-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
          {locale.app.name} v{__APP_VERSION__}
        </p>
      </div>
    </main>
  )
}
