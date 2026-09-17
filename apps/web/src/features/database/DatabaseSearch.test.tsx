import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSearch } from './DatabaseSearch.tsx'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouteContext: () => ({ session: { dialect: 'mysql', host: 'h', port: 3306 } }),
}))

vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables', 'shop', ''],
    queryFn: async () => [
      { name: 'users', kind: 'table', rowEstimate: 1 },
      { name: 'posts', kind: 'table', rowEstimate: 1 },
    ],
  }),
  searchTable: vi.fn(async () => ({ total: 1, count: 'exact', columns: ['name'], sql: 'SELECT 1' })),
}))

describe('DatabaseSearch', () => {
  it('can search again after a run, also under StrictMode (mount, cleanup, mount in development)', async () => {
    // A "still mounted" flag set false in the effect cleanup stays false after StrictMode remounts, and a state
    // update guarded by it never runs: Search would stay disabled for good after the first search.
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <DatabaseSearch db="shop" />
        </QueryClientProvider>
      </StrictMode>
    )
    const search = await screen.findByRole('button', { name: '検索する' })
    await userEvent.type(screen.getByLabelText('検索する語'), 'a')
    await userEvent.click(search)
    await waitFor(() => expect(screen.getByText('2 / 2 テーブルを検索しました')).toBeInTheDocument())
    await waitFor(() => expect(search).toBeEnabled())
  })
})
