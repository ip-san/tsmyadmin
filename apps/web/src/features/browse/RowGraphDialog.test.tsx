import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowseResult } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { RowGraphDialog } from './RowGraphDialog.tsx'
import { REFERRING_SHOWN, type RowNode, rowNode } from './row-graph.ts'

const t = locale.rowGraph

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <a
      href="/table"
      onClick={(e) => {
        e.preventDefault()
        onClick?.()
      }}
    >
      {children}
    </a>
  ),
}))

const reads = vi.fn()
let answer: () => Promise<Pick<BrowseResult, 'rows' | 'total' | 'count'>>
vi.mock('@/lib/queries.ts', () => ({
  rowsQuery: (ref: { table: string }, options: unknown) => ({
    queryKey: ['rows', ref.table, options],
    queryFn: async () => {
      reads(ref.table)
      return { ...posts, ...(await answer()) }
    },
  }),
}))

const users: RowNode['page'] = {
  columns: [
    { name: 'id', dataType: 'int' },
    { name: 'name', dataType: 'varchar' },
  ],
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [],
  referencedBy: [
    { name: 'fk', fromNamespace: { database: 'shop' }, fromTable: 'posts', fromColumns: ['user_id'], columns: ['id'] },
  ],
}
const posts: RowNode['page'] = {
  columns: [
    { name: 'id', dataType: 'int' },
    { name: 'user_id', dataType: 'int' },
  ],
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [],
  referencedBy: [],
}
const root = rowNode({ db: 'shop', table: 'users' }, users, [1, 'Alice'])

const open = (onClose = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RowGraphDialog root={root} onClose={onClose} />
    </QueryClientProvider>
  )
  return onClose
}
const expandRoot = () => screen.getByRole('button', { name: t.expand('users id=1') })

describe('RowGraphDialog', () => {
  // jsdom has <dialog> but not its modal methods.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
    }
  })

  it('adds the rows read, says how many, and keeps the focus on the button pressed', async () => {
    reads.mockClear()
    answer = async () => ({ rows: [[7, 1]], total: 1, count: 'exact' })
    open()
    const button = expandRoot()
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText(t.added(1))).toBeInTheDocument()
    expect(screen.getByText('posts id=7', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(t.refersTo('posts id=7', 'users id=1', 'user_id'))).toBeInTheDocument()
    // Opened, it stays a button (marked unavailable), so the focus is not dropped.
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveTextContent(t.expanded)
    await userEvent.click(button)
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('reads once however fast it is pressed, and says it is reading meanwhile', async () => {
    reads.mockClear()
    let finish: (() => void) | undefined
    answer = () =>
      new Promise((resolve) => {
        finish = () => resolve({ rows: [], total: 0, count: 'exact' })
      })
    open()
    await userEvent.dblClick(expandRoot())
    expect(await screen.findByRole('status')).toHaveTextContent(t.reading)
    finish?.()
    expect(await screen.findByText(t.added(0))).toBeInTheDocument()
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('shows the error of a read that failed, and the row can be opened again', async () => {
    answer = async () => {
      throw new Error('gone away')
    }
    open()
    await userEvent.click(expandRoot())
    expect(await screen.findByText(/gone away/)).toBeInTheDocument()
    expect(expandRoot()).toHaveAttribute('aria-disabled', 'false')
  })

  it('links the rows not read to their table, and closes as it goes there', async () => {
    answer = async () => ({
      rows: Array.from({ length: REFERRING_SHOWN }, (_, i) => [i + 1, 1]),
      total: 12,
      count: 'exact',
    })
    const onClose = open()
    await userEvent.click(expandRoot())
    const more = await screen.findByRole('link', { name: t.openMore(2, 'posts') })
    await userEvent.click(more)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
