import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { dependencyId } from '@/lib/dependencies.ts'
import { UsedByCard } from './UsedByCard.tsx'

const t = locale.dependencies
let tableList: { name: string; kind: string }[] = []
let tablesFail = false
let triggersFail = false
let triggerList: { name: string; table: string }[] = []

vi.mock('@tanstack/react-router', () => ({
  // The address the link goes to, written out: what it carries is what is checked.
  Link: ({ children, to, params, search }: { children: ReactNode; to: string; params: object; search: object }) => (
    <a href={`${to}?${JSON.stringify({ params, search })}`}>{children}</a>
  ),
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
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      if (tablesFail) throw new Error('no table list')
      return tableList
    },
  }),
  triggersQuery: () => ({
    queryKey: ['triggers'],
    queryFn: async () => {
      if (triggersFail) throw new Error('no trigger list')
      return triggerList
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

  it('lists a trigger on a view the catalog lists nowhere else, on that view', async () => {
    triggerList = [{ name: 'instead', table: 'constants' }]
    tableList = [{ name: 'constants', kind: 'materialized_view' }]
    try {
      mount('constants', true)
      expect(await screen.findByText(t.triggerNamed('instead', 'constants'))).toBeInTheDocument()
    } finally {
      triggerList = []
      tableList = []
    }
  })

  it('does not say nothing uses it when the list of tables could not be read', async () => {
    tablesFail = true
    try {
      mount('recent', true)
      expect(await screen.findByText(/no table list/)).toBeInTheDocument()
      expect(screen.queryByText(t.usedByNone)).toBeNull()
    } finally {
      tablesFail = false
    }
  })

  it('links each view to its overview, and opens the diagram with this one chosen', async () => {
    mount('users')
    const active = await screen.findByRole('link', { name: t.named(t.kinds.view, 'active') })
    expect(active.getAttribute('href')).toContain('/overview?')
    expect(active.getAttribute('href')).toContain('"table":"active"')
    const all = screen.getByRole('link', { name: t.openAll })
    expect(all.getAttribute('href')).toContain(JSON.stringify({ focus: dependencyId('table', 'users') }).slice(1, -1))
  })

  it('names a routine or a trigger without a link, and opens the diagram unchosen for what nothing uses', async () => {
    triggerList = [{ name: 'stamp', table: 'users' }]
    try {
      const { unmount } = mount('users')
      expect(await screen.findByText(t.triggerNamed('stamp', 'users'))).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: t.triggerNamed('stamp', 'users') })).toBeNull()
      unmount()
    } finally {
      triggerList = []
    }
    // lonely takes no part in any dependency: not in the diagram, so the link chooses nothing.
    mount('lonely')
    const all = await screen.findByRole('link', { name: t.openAll })
    expect(all.getAttribute('href')).not.toContain('focus')
  })
})
