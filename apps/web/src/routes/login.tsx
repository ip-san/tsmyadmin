import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { locale } from '@/config/locale.ts'
import { LoginForm } from '@/features/auth/LoginForm.tsx'
import { mutations, sessionQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/login')({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery)
    if (session) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <h1 className="mb-1 text-xl font-bold text-zinc-900 dark:text-zinc-50">{locale.app.name}</h1>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{locale.login.title}</p>
        <LoginForm
          onLogin={async (body) => {
            const info = await mutations.login(body)
            // ensureQueryData() in route guards returns cached data as-is, so write the new session directly.
            queryClient.setQueryData(sessionQuery.queryKey, info)
            await navigate({ to: '/' })
          }}
        />
      </div>
    </main>
  )
}
