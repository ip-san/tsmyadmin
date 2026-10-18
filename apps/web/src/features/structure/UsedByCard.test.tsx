import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { UsedByCard } from './UsedByCard.tsx'

const t = locale.dependencies
let triggersFail = false

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/dependencies">{children}</a>,
}))
vi.mock('@/lib/queries.ts', () => ({
  dependenciesQuery: () => ({
    queryKey: ['dependencies'],
    queryFn: async () => ({
      status: 'ok',
      objects: [
        { kind: 'view', name: 'active', dependsOn: [{ kind: 'table', name: 'users' }] },
        { kind: 'view', name: 'recent', dependsOn: [{ kind: 'view', name: 'active' }] },
      ],
    }),
  }),
  tablesQuery: () => ({ queryKey: ['tables'], queryFn: async () => [] }),
  triggersQuery: () => ({
    queryKey: ['triggers'],
    queryFn: async () => {
      if (triggersFail) throw new Error('no trigger list')
      return []
    },
  }),
}))

const mount = (table: string, view = false) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UsedByCard tableRef={{ db: 'shop', table }} view={view} />
    </QueryClientProvider>
  )

describe('UsedByCard', () => {
  it('lists what a change to the table reaches, through views on views', async () => {
    mount('users')
    expect(await screen.findByText(t.named(t.kinds.view, 'recent'))).toBeInTheDocument()
    expect(screen.getByText(t.named(t.kinds.view, 'active'))).toBeInTheDocument()
  })

  it('looks a view up as a view, and says when nothing uses it', async () => {
    mount('active', true)
    expect(await screen.findByText(t.named(t.kinds.view, 'recent'))).toBeInTheDocument()
    mount('recent', true)
    expect(await screen.findByText(t.usedByNone)).toBeInTheDocument()
  })

  it('still lists what views use when the triggers cannot be listed, saying why they are missing', async () => {
    triggersFail = true
    try {
      mount('users')
      expect(await screen.findByText(/no trigger list/)).toBeInTheDocument()
      expect(screen.getByText(t.named(t.kinds.view, 'active'))).toBeInTheDocument()
      // Something may be on a table no view uses: not said to be nothing.
      mount('recent', true)
      await waitFor(() => expect(screen.getAllByText(/no trigger list/)).toHaveLength(2))
      expect(screen.queryByText(t.usedByNone)).toBeNull()
    } finally {
      triggersFail = false
    }
  })
})
