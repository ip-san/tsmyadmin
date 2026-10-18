import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { MetadataSearch } from './MetadataSearch.tsx'

const t = locale.metadataSearch
const described = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/structure">{children}</a>,
}))

vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => [
      { name: 'users', kind: 'table' },
      { name: 'posts', kind: 'table' },
      { name: 'broken', kind: 'view' },
      { name: 'seq', kind: 'sequence' },
    ],
  }),
  structureQuery: ({ table }: { table: string }) => ({
    queryKey: ['structure', table],
    queryFn: async () => {
      described(table)
      if (table === 'broken') throw new Error('cannot read')
      const columns =
        table === 'users'
          ? [{ name: 'id', dataType: 'int', comment: null }]
          : [{ name: 'user_id', dataType: 'int', comment: '書いた会員' }]
      return { name: table, comment: table === 'users' ? '会員' : null, columns }
    },
  }),
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MetadataSearch db="shop" />
    </QueryClientProvider>
  )

describe('MetadataSearch', () => {
  it('reads no definition before a term is typed', () => {
    described.mockClear()
    mount()
    expect(described).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('finds by comment across tables, marks what matched, and says what could not be searched', async () => {
    described.mockClear()
    mount()
    await userEvent.type(screen.getByLabelText(t.term), '会員')
    expect(await screen.findByRole('status')).toHaveTextContent(t.found(2, 2))
    const table = screen.getByRole('table', { name: t.results })
    expect(table.querySelectorAll('mark')).toHaveLength(2)
    expect(screen.getByText(t.failed(['broken']))).toBeInTheDocument()
    // Each table is described once however many letters are typed; a sequence not at all.
    expect(described.mock.calls.map((c) => c[0]).sort()).toEqual(['broken', 'posts', 'users'])
  })

  it('says none was found, without a table', async () => {
    mount()
    await userEvent.type(screen.getByLabelText(t.term), 'nowhere')
    expect(await screen.findByRole('status')).toHaveTextContent(t.found(0, 2))
    expect(screen.queryByRole('table', { name: t.results })).toBeNull()
  })
})
