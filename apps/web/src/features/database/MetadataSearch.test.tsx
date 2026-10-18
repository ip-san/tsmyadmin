import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { MetadataSearch } from './MetadataSearch.tsx'

const t = locale.metadataSearch
const described = vi.fn()
const listed = vi.fn()
/** Extra columns of posts, named w0, w1…: to go past the rows drawn at most. */
let wide = 0
const readsOf = (table: string) => described.mock.calls.filter((c) => c[0] === table).length

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/structure">{children}</a>,
}))

vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      listed()
      return [
        { name: 'users', kind: 'table' },
        { name: 'posts', kind: 'table' },
        { name: 'broken', kind: 'view' },
        { name: 'seq', kind: 'sequence' },
      ]
    },
  }),
  structureQuery: ({ table }: { table: string }) => ({
    queryKey: ['structure', table],
    queryFn: async () => {
      described(table)
      if (table === 'broken') throw new Error('cannot read')
      const columns =
        table === 'users'
          ? [{ name: 'id', dataType: 'int', comment: null }]
          : [
              { name: 'user_id', dataType: 'int', comment: '書いた会員' },
              ...Array.from({ length: wide }, (_, i) => ({ name: `w${i}`, dataType: 'int', comment: null })),
            ]
      return { name: table, comment: table === 'users' ? '会員' : null, columns }
    },
  }),
}))

const mount = () =>
  render(
    // Stale at once by default, as everything is after the app's few seconds: what this screen keeps longer, it says.
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}>
      <MetadataSearch db="shop" />
    </QueryClientProvider>
  )

describe('MetadataSearch', () => {
  it('reads no definition before a term is typed', () => {
    described.mockClear()
    mount()
    expect(described).not.toHaveBeenCalled()
    // The live region is there from the start, empty, so what it says later is heard.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('finds by comment across tables, marks what matched, and says what could not be searched', async () => {
    described.mockClear()
    mount()
    await userEvent.type(screen.getByLabelText(t.term), '会員')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.found(2, 2)))
    const table = screen.getByRole('table', { name: t.results })
    expect(table.querySelectorAll('mark')).toHaveLength(2)
    // What was not searched is read out with the count, not only shown.
    expect(screen.getByRole('status')).toHaveTextContent(t.failed(['broken']))
    // Each table is described once however many letters are typed; a sequence not at all.
    expect(described.mock.calls.map((c) => c[0]).sort()).toEqual(['broken', 'posts', 'users'])
  })

  it('follows the term as it changes: none found, then the matches of the new term', async () => {
    mount()
    const input = screen.getByLabelText(t.term)
    await userEvent.type(input, 'nowhere')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.found(0, 2)))
    expect(screen.queryByRole('table', { name: t.results })).toBeNull()
    await userEvent.clear(input)
    await userEvent.type(input, 'user_id')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.found(1, 2)))
    const marks = screen.getByRole('table', { name: t.results }).querySelectorAll('mark')
    expect([...marks].map((m) => m.textContent)).toEqual(['user_id'])
  })

  it('reads again only the tables that could not be read, when asked', async () => {
    described.mockClear()
    mount()
    await userEvent.type(screen.getByLabelText(t.term), 'id')
    await userEvent.click(await screen.findByRole('button', { name: t.readAgain }))
    await waitFor(() => expect(readsOf('broken')).toBe(2))
    expect(readsOf('users')).toBe(1)
    expect(readsOf('posts')).toBe(1)
  })

  it('does not read the definitions again when the term is cleared and typed again', async () => {
    described.mockClear()
    listed.mockClear()
    mount()
    const input = screen.getByLabelText(t.term)
    await userEvent.type(input, 'id')
    await waitFor(() => expect(screen.getByRole('status')).not.toBeEmptyDOMElement())
    await userEvent.clear(input)
    await userEvent.type(input, 'id')
    await waitFor(() => expect(screen.getByRole('status')).not.toBeEmptyDOMElement())
    expect(readsOf('users')).toBe(1)
    // Not even the list of tables: the search is not run again.
    expect(listed).toHaveBeenCalledTimes(1)
  })

  it('reads the count out once typing pauses, and shows it at once without reading it twice', async () => {
    mount()
    const input = screen.getByLabelText(t.term)
    await userEvent.type(input, 'user_id')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.found(1, 2)))
    await userEvent.clear(input)
    await userEvent.type(input, 'zzz')
    // Shown at once, in a line a screen reader skips; the status still says the last count for now.
    expect(screen.getByText(new RegExp(`^${t.found(0, 2)}`))).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(t.found(1, 2))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.found(0, 2)))
  })

  it('draws at most 200 rows, and says so', async () => {
    wide = 250
    try {
      mount()
      await userEvent.type(screen.getByLabelText(t.term), 'w')
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.shownFirst(200)))
      // The header row and 200 more.
      expect(screen.getByRole('table', { name: t.results }).querySelectorAll('tbody tr')).toHaveLength(200)
    } finally {
      wide = 0
    }
  })
})
