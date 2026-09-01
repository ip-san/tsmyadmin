import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { isApiError } from './lib/api.ts'
import { applyTheme } from './lib/theme.ts'
import { routeTree } from './routeTree.gen.ts'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } },
  queryCache: new QueryCache({
    onError: (error) => {
      if (isApiError(error, 'UNAUTHENTICATED')) {
        queryClient.setQueryData(['session'], null)
        void router.navigate({ to: '/login' })
      }
    },
  }),
})

const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', scrollRestoration: true })

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
