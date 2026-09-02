import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ErrorPage, NotFoundPage } from './components/layout/ErrorPage.tsx'
import { isApiError } from './lib/api.ts'
import { applyTheme } from './lib/theme.ts'
import { routeTree } from './routeTree.gen.ts'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } },
  queryCache: new QueryCache({
    onError: (error) => {
      if (isApiError(error, 'UNAUTHENTICATED')) {
        queryClient.setQueryData(['session'], null)
        // Remember where the user was so the login page can send them back after re-authenticating.
        void router.navigate({ to: '/login', search: { redirect: router.state.location.href, expired: true } })
      }
    },
  }),
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
