import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { BrandMark } from '@/components/layout/BrandMark.tsx'
import { Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { DiscoveryHelp } from '@/features/auth/DiscoveryHelp.tsx'
import { LoginForm } from '@/features/auth/LoginForm.tsx'
import { serverHomePath } from '@/lib/default-tabs.ts'
import { useDocumentTitle } from '@/lib/document-title.ts'
import { discoveryDiagnosisQuery, mutations, serversQuery, sessionQuery } from '@/lib/queries.ts'
import { safeRedirect } from '@/lib/redirect.ts'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    redirect: z.string().optional(),
    expired: z.boolean().optional(),
    passwordChanged: z.boolean().optional(),
  }),
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
  const diagnosis = useQuery(discoveryDiagnosisQuery)
  useDocumentTitle(locale.login.title)
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-md">
        {/* The product names itself before the form: this is the first screen anyone sees. */}
        <div className="mb-5 flex items-center gap-3">
          <BrandMark size={40} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">{locale.app.name}</h1>
            <p className="text-sm text-ink-sub">{locale.app.tagline}</p>
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface p-6 shadow-raised">
          <h2 className="mb-4 text-sm font-semibold text-ink">{locale.login.title}</h2>
          {search.passwordChanged ? <Notice className="mb-4">{locale.login.passwordChanged}</Notice> : null}
          {search.expired ? <Notice className="mb-4">{locale.login.sessionExpired}</Notice> : null}
          {servers.isPending ? (
            <Spinner />
          ) : (
            <LoginForm
              presets={servers.data ?? []}
              onLogin={async (body) => {
                const info = await mutations.login(body)
                // An expired session leaves the previous account's data cached (logging out clears it, timing out
                // does not). Signing in as someone else must not show their databases — or their bookmarks.
                queryClient.clear()
                // ensureQueryData() in route guards returns cached data as-is, so write the new session directly.
                queryClient.setQueryData(sessionQuery.queryKey, info)
                await navigate({ href: search.redirect ? safeRedirect(search.redirect) : serverHomePath() })
              }}
            />
          )}
        </div>
        <DiscoveryHelp diagnosis={diagnosis.data} />
        <p className="mt-4 text-center text-xs text-ink-faint">
          {locale.app.name} v{__APP_VERSION__}
        </p>
      </div>
    </main>
  )
}
