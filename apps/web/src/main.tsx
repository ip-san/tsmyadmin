import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ErrorPage, NotFoundPage } from './components/layout/ErrorPage.tsx'
import { isApiError } from './lib/api.ts'
import { applyTheme } from './lib/theme.ts'
import { routeTree } from './routeTree.gen.ts'

/**
 * Any 401 (UNAUTHENTICATED, or AUTH_FAILED once the database rejected a resumed session's credentials) sends the
 * user to the login page with a link back to where they were. Several queries can fail in the same tick; only the
 * first one navigates, so the redirect target is the real page and not a nested /login URL.
 */
function onUnauthorized(error: unknown): void {
  if (!isApiError(error) || error.status !== 401) return
  if (router.state.location.pathname === '/login' || queryClient.getQueryData(['session']) === null) return
  queryClient.setQueryData(['session'], null)
  void router.navigate({ to: '/login', search: { redirect: router.state.location.href, expired: true } })
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } },
  queryCache: new QueryCache({ onError: onUnauthorized }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultErrorComponent: ({ error, reset }) => <ErrorPage error={error} reset={reset} />,
  defaultNotFoundComponent: NotFoundPage,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

applyTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
