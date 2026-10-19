import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TableSchema } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, table } from '@/test/schema-fixtures.ts'
import { DataDictionary } from './DataDictionary.tsx'
import { dictionaryMarkdown } from './dictionary-markdown.ts'

const t = locale.dictionary

/** What the mocked API answers, set afresh for each test. */
let schemas: Record<string, TableSchema>
let failing: Set<string>
/** A reading held until the test lets it go, to press the button while it reads. */
let hold: Promise<void> | null
/** Tables read last: their reading waits for this. */
let slow: { tables: Set<string>; until: Promise<void> } | null
let listed: { name: string; kind: string }[]
const saved = vi.hoisted(() => [] as { filename: string; text: string; mime: string }[])

beforeEach(() => {
  schemas = {
    users: table('users', { columns: [column('id', 'int')] }),
    posts: table('posts', { columns: [column('id', 'int')] }),
    v_posts: table('v_posts', { kind: 'view', primaryKey: [] }),
  }
  failing = new Set()
  hold = null
  slow = null
  saved.length = 0
  // Listed in the server's order, which the file keeps; a sequence is not a table of the dictionary.
  listed = [
    { name: 'users', kind: 'table' },
    { name: 'posts', kind: 'table' },
    { name: 'v_posts', kind: 'view' },
    { name: 'seq', kind: 'sequence' },
  ]
})

vi.mock('@/lib/download.ts', async (actual) => ({
  ...(await actual<typeof import('@/lib/download.ts')>()),
  downloadText: (filename: string, text: string, mime: string) => saved.push({ filename, text, mime }),
}))
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => listed,
  }),
  structureQuery: ({ table: name }: { table: string }) => ({
    queryKey: ['structure', name],
    queryFn: async () => {
      if (hold) await hold
      if (slow?.tables.has(name)) await slow.until
      if (failing.has(name)) throw new Error('cannot read')
      return schemas[name]
    },
  }),
}))

function mount(schema?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DataDictionary db="shop" schema={schema} />
    </QueryClientProvider>
  )
  return client
}
const held = () => {
  let release: () => void = () => undefined
  const until = new Promise<void>((r) => {
    release = r
  })
  return { until, release: () => release() }
}
const save = () => screen.getByRole('button', { name: t.markdown })

describe('DataDictionary', () => {
  it('saves nothing while the definitions are read, and says why', async () => {
    let release: () => void = () => undefined
    hold = new Promise((r) => {
      release = r
    })
    mount()
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'true'))
    expect(save()).toHaveAttribute('title', t.markdownHint)
    fireEvent.click(save())
    expect(saved).toEqual([])
    release()
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'false'))
    expect(save()).not.toHaveAttribute('title')
  })

  it('saves every table and view read, in the order listed, as a Markdown file named for the database', async () => {
    // posts arrives last: the file still follows the list, not the order of arrival.
    const late = held()
    slow = { tables: new Set(['posts']), until: late.until }
    mount('app')
    await waitFor(() => expect(screen.getByRole('table', { name: 'v_posts' })).toBeInTheDocument())
    late.release()
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(save())
    const all = [schemas.users, schemas.posts, schemas.v_posts].flatMap((s) => s ?? [])
    expect(saved).toEqual([
      { filename: 'shop_app-dictionary.md', text: dictionaryMarkdown('shop.app', all, []), mime: 'text/markdown' },
    ])
  })

  it('names in the file the tables that could not be read', async () => {
    failing = new Set(['posts'])
    mount()
    await waitFor(() => expect(screen.getByText(t.failed(['posts']))).toBeInTheDocument())
    fireEvent.click(save())
    const read = [schemas.users, schemas.v_posts].flatMap((s) => s ?? [])
    expect(saved.map((f) => [f.filename, f.text])).toEqual([
      ['shop-dictionary.md', dictionaryMarkdown('shop', read, ['posts'])],
    ])
  })

  it('saves nothing while it shows the reading before the list of tables changed', async () => {
    const client = mount()
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'false'))
    // A table made elsewhere: the list is read again, and the new table is still being read.
    const late = held()
    slow = { tables: new Set(['tags']), until: late.until }
    listed = [...listed, { name: 'tags', kind: 'table' }]
    schemas.tags = table('tags')
    await client.invalidateQueries({ queryKey: ['tables'] })
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'true'))
    fireEvent.click(save())
    expect(saved).toEqual([])
    late.release()
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(save())
    expect(saved[0]?.text).toContain('\n## tags\n')
  })

  it('cuts a long name of the database, and keeps the -dictionary.md the file ends with', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DataDictionary db={'d'.repeat(80)} schema={undefined} />
      </QueryClientProvider>
    )
    await waitFor(() => expect(save()).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(save())
    expect(saved[0]?.filename).toBe(`${'d'.repeat(40)}-dictionary.md`)
  })

  it('keeps one status line from the start, and empties it once every definition is read', async () => {
    const late = held()
    hold = late.until
    mount()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.progress(0, 3)))
    late.release()
    await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement())
  })
})
