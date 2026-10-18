import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { TableOverview } from './TableOverview.tsx'

const t = locale.overview

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/designer">{children}</a>,
}))
vi.mock('@/lib/session.ts', () => ({ useDialect: () => 'mysql' }))

let kind = 'table'
const posts = {
  name: 'posts',
  kind: 'table',
  comment: '投稿',
  columns: [
    { name: 'id', dataType: 'int' },
    { name: 'user_id', dataType: 'int' },
    { name: 'body', dataType: 'text' },
    { name: 'title', dataType: 'text' },
  ],
  primaryKey: ['id'],
  foreignKeys: [{ name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
  referencedBy: [],
}
const key = (table: string, refTable: string) => ({
  table,
  name: `fk_${table}_${refTable}`,
  columns: [`${refTable}_id`],
  refNamespace: { database: 'shop' },
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
})

vi.mock('@/lib/queries.ts', () => ({
  structureQuery: () => ({ queryKey: ['structure'], queryFn: async () => ({ ...posts, kind }) }),
  tableStatsQuery: () => ({
    queryKey: ['stats'],
    queryFn: async () => ({ rowEstimate: 3, totalBytes: 16384, updatedAt: null }),
  }),
  tableUsageQuery: () => ({
    queryKey: ['usage'],
    queryFn: async () => ({
      status: 'ok',
      unit: 'rows',
      since: null,
      tables: [{ table: 'posts', fullReads: 9, indexReads: 2 }],
      indexes: [],
    }),
  }),
  columnProfileQuery: () => ({
    queryKey: ['profile'],
    queryFn: async () => ({
      sampled: 3,
      capped: false,
      columns: [
        { column: 'id', nulls: 0, distinct: 3, prefix: false },
        { column: 'user_id', nulls: 0, distinct: 1, prefix: false },
        { column: 'body', nulls: 3, distinct: 0, prefix: true },
        { column: 'title', nulls: 0, distinct: 2, prefix: true },
      ],
      omitted: 0,
    }),
  }),
  rowsQuery: () => ({
    queryKey: ['rows'],
    queryFn: async () => ({
      rows: [
        [1, 7, null],
        [2, 7, null],
      ],
    }),
  }),
  // posts → users; comments → posts; users → orgs (two keys away from posts: not drawn).
  foreignKeysQuery: () => ({
    queryKey: ['fk'],
    queryFn: async () => [key('posts', 'users'), key('comments', 'posts'), key('users', 'orgs')],
  }),
  distinctValuesQuery: () => ({ queryKey: ['distinct'], queryFn: async () => ({ values: [], truncated: false }) }),
  dependenciesQuery: () => ({ queryKey: ['deps'], queryFn: async () => ({ status: 'ok', objects: [] }) }),
  triggersQuery: () => ({ queryKey: ['triggers'], queryFn: async () => [] }),
  tablesQuery: () => ({ queryKey: ['tables'], queryFn: async () => [] }),
}))

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TableOverview tableRef={{ db: 'shop', table: 'posts' }} />
    </QueryClientProvider>
  )

describe('TableOverview', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
    }
  })

  it('says what the table is from its keys, with its comment, size and reads', async () => {
    mount()
    expect(await screen.findByText(t.roles.detail)).toBeInTheDocument()
    expect(screen.getByText(t.roleWhy(1, 0))).toBeInTheDocument()
    expect(screen.getByText('投稿')).toBeInTheDocument()
    expect(await screen.findByText(t.usage(9, 2, 'rows'))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`^${t.size(3, locale.common.bytes(16384), null)}`))).toBeInTheDocument()
  })

  it('shows what each column holds, with the marks, and opens the values of one', async () => {
    mount()
    const columns = await screen.findByRole('table', { name: t.columnsTable })
    const row = (name: string) => within(columns).getByRole('row', { name: new RegExp(`^${name} `) })
    expect(row('id')).toHaveTextContent(t.notes.unique)
    expect(row('user_id')).toHaveTextContent(t.notes.constant)
    expect(row('body')).toHaveTextContent(t.notes.allNull)
    // Counted by its first characters: "or more", and no mark on how many there are.
    expect(row('title')).toHaveTextContent(t.atLeast(2))
    expect(row('id')).toHaveTextContent(t.count(3))
    expect(within(row('body')).getByRole('meter', { name: t.nullShareOf('body') })).toHaveProperty('value', 1)
    expect(screen.getByText(t.sampleAll(3))).toBeInTheDocument()
    await userEvent.click(within(row('id')).getByRole('button', { name: t.valuesOf('id') }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a few rows, and the tables one key away (not two)', async () => {
    mount()
    const sample = await screen.findByRole('table', { name: t.sample })
    expect(within(sample).getAllByRole('row')).toHaveLength(3)
    const keys = await screen.findByRole('list', { name: t.neighboursList })
    expect(
      within(keys)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([t.keySentence('posts', 'users_id', 'users'), t.keySentence('comments', 'posts_id', 'posts')])
    expect(screen.getByRole('img', { name: t.neighboursDiagram('posts') })).toBeInTheDocument()
  })

  it('counts the columns of a view only when asked, and shows no rows or counts for a sequence', async () => {
    kind = 'view'
    try {
      const { unmount } = mount()
      expect(await screen.findByText(t.isView)).toBeInTheDocument()
      // Neither counted nor shown before asked: a view's rows are worked out when read.
      expect(screen.queryByRole('table', { name: t.columnsTable })).toBeNull()
      expect(screen.queryByRole('table', { name: t.sample })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: t.countNow }))
      expect(await screen.findByRole('table', { name: t.columnsTable })).toBeInTheDocument()
      expect(await screen.findByRole('table', { name: t.sample })).toBeInTheDocument()
      unmount()
      kind = 'sequence'
      mount()
      await screen.findByText(t.isSequence)
      expect(screen.queryByRole('button', { name: t.countNow })).toBeNull()
      expect(screen.queryByRole('table', { name: t.sample })).toBeNull()
    } finally {
      kind = 'table'
    }
  })
})
