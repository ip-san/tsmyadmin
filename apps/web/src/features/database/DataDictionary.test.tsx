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
const saved = vi.hoisted(() => [] as { filename: string; text: string; mime: string }[])

beforeEach(() => {
  schemas = {
    users: table('users', { columns: [column('id', 'int')] }),
    posts: table('posts', { columns: [column('id', 'int')] }),
    v_posts: table('v_posts', { kind: 'view', primaryKey: [] }),
  }
  failing = new Set()
  hold = null
  saved.length = 0
})

vi.mock('@/lib/download.ts', async (actual) => ({
  ...(await actual<typeof import('@/lib/download.ts')>()),
  downloadText: (filename: string, text: string, mime: string) => saved.push({ filename, text, mime }),
}))
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
    // Listed in the server's order, which the file keeps; a sequence is not a table of the dictionary.
    queryFn: async () => [
      { name: 'users', kind: 'table' },
      { name: 'posts', kind: 'table' },
      { name: 'v_posts', kind: 'view' },
      { name: 'seq', kind: 'sequence' },
    ],
  }),
  structureQuery: ({ table: name }: { table: string }) => ({
    queryKey: ['structure', name],
    queryFn: async () => {
      if (hold) await hold
      if (failing.has(name)) throw new Error('cannot read')
      return schemas[name]
    },
  }),
}))

const mount = (schema?: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DataDictionary db="shop" schema={schema} />
    </QueryClientProvider>
  )
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
    mount('app')
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
})
