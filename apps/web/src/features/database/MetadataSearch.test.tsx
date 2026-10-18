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
/** How many views cannot be described (broken, broken2…). */
let broken = 1
/** While set, a view that cannot be described takes until it is opened to say so: to see a reading again. */
let gate: Promise<void> | undefined
/** The list of tables cannot be read (the server gone, say). */
let listFails = false
const brokenNames = () => Array.from({ length: broken }, (_, i) => (i === 0 ? 'broken' : `broken${i + 1}`))
const readsOf = (table: string) => described.mock.calls.filter((c) => c[0] === table).length

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/structure">{children}</a>,
}))

vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      listed()
      if (listFails) throw new Error('server gone')
      return [
        { name: 'users', kind: 'table' },
        { name: 'posts', kind: 'table' },
        ...brokenNames().map((name) => ({ name, kind: 'view' })),
        { name: 'seq', kind: 'sequence' },
      ]
    },
  }),
  structureQuery: ({ table }: { table: string }) => ({
    queryKey: ['structure', table],
    queryFn: async () => {
      described(table)
      if (table.startsWith('broken')) {
        await gate
        throw new Error('cannot read')
      }
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

/** The status line says exactly these sentences (a count of 11 is not a count of 1). */
const says = (...sentences: string[]) =>
  waitFor(() => expect(screen.getByRole('status').textContent).toBe(sentences.join(' ')))
const failedOne = t.failed(['broken'], 0)

describe('MetadataSearch', () => {
  it('reads no definition before a term is typed', () => {
    described.mockClear()
    mount()
    expect(described).not.toHaveBeenCalled()
    // The status line is there from the start, empty, so what it says later is heard.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('finds by comment across tables, marks what matched, and says what could not be searched', async () => {
    described.mockClear()
    mount()
    await userEvent.type(screen.getByLabelText(t.term), '会員')
    // What was not searched is said with the count, in the line that stays (it can be read again).
    await says(t.found(2, 2), failedOne)
    const table = screen.getByRole('table', { name: t.results })
    expect(table.querySelectorAll('mark')).toHaveLength(2)
    // Each table is described once however many letters are typed; a sequence not at all.
    expect(described.mock.calls.map((c) => c[0]).sort()).toEqual(['broken', 'posts', 'users'])
  })

  it('names a few of the tables that could not be read, and counts the rest', async () => {
    broken = 8
    try {
      mount()
      await userEvent.type(screen.getByLabelText(t.term), 'id')
      await says(t.found(2, 2), t.failed(brokenNames().slice(0, 5), 3))
    } finally {
      broken = 1
    }
  })

  it('follows the term as it changes: none found, then the matches of the new term', async () => {
    mount()
    const input = screen.getByLabelText(t.term)
    await userEvent.type(input, 'nowhere')
    await says(t.found(0, 2), failedOne)
    expect(screen.queryByRole('table', { name: t.results })).toBeNull()
    await userEvent.clear(input)
    await userEvent.type(input, 'user_id')
    await says(t.found(1, 2), failedOne)
    const marks = screen.getByRole('table', { name: t.results }).querySelectorAll('mark')
    expect([...marks].map((m) => m.textContent)).toEqual(['user_id'])
  })

  it('reads again only the tables that could not be read, saying so meanwhile', async () => {
    described.mockClear()
    mount()
    await userEvent.type(screen.getByLabelText(t.term), 'id')
    await says(t.found(2, 2), failedOne)
    let open: () => void = () => undefined
    gate = new Promise((resolve) => {
      open = resolve
    })
    try {
      const again = screen.getByRole('button', { name: t.readAgain })
      await userEvent.click(again)
      await says(t.found(2, 2), failedOne, t.refreshing)
      // Not pressed twice while it reads.
      expect(again).toBeDisabled()
      open()
      await says(t.found(2, 2), failedOne)
    } finally {
      gate = undefined
    }
    expect(readsOf('broken')).toBe(2)
    expect(readsOf('users')).toBe(1)
    expect(readsOf('posts')).toBe(1)
  })

  it('does not read the definitions again when the term is cleared and typed again', async () => {
    described.mockClear()
    listed.mockClear()
    mount()
    const input = screen.getByLabelText(t.term)
    await userEvent.type(input, 'id')
    await says(t.found(2, 2), failedOne)
    await userEvent.clear(input)
    await userEvent.type(input, 'id')
    await says(t.found(2, 2), failedOne)
    expect(readsOf('users')).toBe(1)
    // Not even the list of tables: the search is not run again.
    expect(listed).toHaveBeenCalledTimes(1)
  })

  it('says the count once typing pauses, not on every key', async () => {
    mount()
    const input = screen.getByLabelText(t.term)
    await userEvent.type(input, 'user_id')
    await says(t.found(1, 2), failedOne)
    await userEvent.clear(input)
    await userEvent.type(input, 'zzz')
    // Typed at once: the line still says the last count for now, then the new one.
    expect(screen.getByRole('status').textContent).toBe(`${t.found(1, 2)} ${failedOne}`)
    await says(t.found(0, 2), failedOne)
  })

  it('draws at most 200 rows, and says so', async () => {
    wide = 250
    try {
      mount()
      await userEvent.type(screen.getByLabelText(t.term), 'w')
      await says(t.found(250, 2), t.shownFirst(200), failedOne)
      expect(screen.getByRole('table', { name: t.results }).querySelectorAll('tbody tr')).toHaveLength(200)
    } finally {
      wide = 0
    }
  })

  it('keeps the results and says nothing of them when reading again fails, showing the error', async () => {
    mount()
    await userEvent.type(screen.getByLabelText(t.term), 'user_id')
    await says(t.found(1, 2), failedOne)
    listFails = true
    try {
      await userEvent.click(screen.getByRole('button', { name: t.readAgain }))
      expect(await screen.findByText(/server gone/)).toBeInTheDocument()
      // The count is not said as if all were well; the results of the reading before stay.
      await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement())
      expect(screen.getByRole('table', { name: t.results })).toBeInTheDocument()
    } finally {
      listFails = false
    }
  })
})
