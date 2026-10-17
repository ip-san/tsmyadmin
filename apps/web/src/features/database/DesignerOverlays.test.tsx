import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RelationDef, SnapshotDiff } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { useDesignerOverlays } from './DesignerOverlays.tsx'

const t = locale.designer

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/designer">{children}</a>,
}))

const checked = vi.fn()
const diff: SnapshotDiff = {
  snapshot: { id: '1', name: 'before', at: '2026-10-01T00:00:00Z', bytes: 1, objects: 2 },
  shape: { tables: [{ name: 'gone', kind: 'table' }], relations: [] },
  added: [{ name: 'tags', before: null, after: 'CREATE TABLE tags' }],
  removed: [{ name: 'gone', before: 'CREATE TABLE gone', after: null }],
  changed: [],
  unchanged: 1,
  unreadable: [],
}

vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({ queryKey: ['tables'] }),
  foreignKeysQuery: () => ({ queryKey: ['fk'] }),
  snapshotDiffQuery: () => ({ queryKey: ['diff'], queryFn: async () => diff }),
  tableUsageQuery: () => ({
    queryKey: ['usage'],
    queryFn: async () => ({ status: 'unsupported', unit: 'rows', since: null, tables: [], indexes: [] }),
  }),
  referenceCheckQuery: (ref: { table: string }) => ({
    queryKey: ['references', ref.table],
    queryFn: async () => {
      checked(ref.table)
      if (ref.table === 'logs') throw new Error('timeout')
      return [
        {
          name: `fk_${ref.table}`,
          columns: ['user_id'],
          refNamespace: { database: 'shop' },
          refTable: 'users',
          refColumns: ['id'],
          orphans: 2,
          sql: 'SELECT …',
        },
      ]
    },
  }),
}))

const key = (table: string): RelationDef => ({
  table,
  name: `fk_${table}`,
  columns: ['user_id'],
  refNamespace: { database: 'shop' },
  refTable: 'users',
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
})

/** The hook's controls and panels, and what overlay it would draw, as text to look for. */
function Harness({ compare }: { compare?: string | undefined }) {
  const o = useDesignerOverlays({
    db: 'shop',
    schema: undefined,
    compare,
    names: ['users', 'posts', 'logs'],
    // A key of a table that is not drawn (a view's, say) is not checked.
    keys: [key('posts'), key('posts'), key('logs'), key('elsewhere')],
  })
  const overlay = o.overlay(undefined)
  return (
    <div>
      {o.controls}
      {o.above}
      {o.below}
      <p data-testid="lit">{[...(overlay?.relationBadges?.values() ?? [])].join(',')}</p>
    </div>
  )
}

const mount = (compare?: string) =>
  render(
    // The app's client retries nothing either for these (a whole-table read is not run twice on its own).
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness compare={compare} />
    </QueryClientProvider>
  )

describe('useDesignerOverlays', () => {
  it('checks the references only when asked, each drawn table with a key once, and says when it is done', async () => {
    checked.mockClear()
    mount()
    expect(checked).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: t.refCheck.check })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(t.refCheck.done(2, 1)))
    expect(checked.mock.calls).toEqual([['posts'], ['logs']])
    // The button keeps its name: whether it is on is aria-pressed, what it is doing the status.
    expect(screen.getByRole('button', { name: t.refCheck.check })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('lit')).toHaveTextContent(t.refCheck.orphans(2))
  })

  it('checks again when pressed again, and says nothing while it is off', async () => {
    checked.mockClear()
    mount()
    const button = screen.getByRole('button', { name: t.refCheck.check })
    await userEvent.click(button)
    await waitFor(() => expect(checked).toHaveBeenCalledTimes(2))
    await userEvent.click(button)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(screen.getByTestId('lit')).toHaveTextContent('')
    await userEvent.click(button)
    await waitFor(() => expect(checked).toHaveBeenCalledTimes(4))
  })

  it('shows why the table reads cannot be shown, under the diagram', async () => {
    mount()
    await userEvent.click(screen.getByRole('checkbox', { name: t.usage.toggle }))
    expect(await screen.findByText(t.usage.unsupported)).toBeInTheDocument()
  })

  it('turns the other overlays off while comparing, and lists the tables of each kind by name', async () => {
    checked.mockClear()
    mount('1')
    expect(await screen.findByText(t.compare.list(t.compare.added, ['tags']))).toBeInTheDocument()
    expect(screen.getByText(t.compare.list(t.compare.removed, ['gone']))).toBeInTheDocument()
    expect(screen.getByText(t.compare.othersOff)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: t.usage.toggle })).toBeDisabled()
    expect(screen.getByRole('button', { name: t.refCheck.check })).toBeDisabled()
    expect(checked).not.toHaveBeenCalled()
  })
})
