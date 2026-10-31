import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { TriedIndexes } from './TriedIndexes.tsx'
import { forgetTried, rememberTried, triedIndexes } from './tried-indexes.ts'
import { useVisualPlan } from './use-visual-plan.tsx'

const p = locale.plan
const SCOPE = 'mysql.db.3306'
/** The indexes each table has now, as its structure answers. */
let indexes: Record<string, string[]>
const previewDdl = vi.fn(async (_db: string, _schema: unknown, op: { op: string; name: string }) => ({
  sql: [`${op.op} ${op.name}`],
}))
const executeSql = vi.fn(async (_db: string, body: { sql: string }) => [
  { kind: 'affected', sql: body.sql, affectedRows: 0, durationMs: 1 },
])

vi.mock('@/lib/queries.ts', () => ({
  sessionQuery: { queryKey: ['session'], queryFn: async () => ({ dialect: 'mysql' }) },
  isDatabaseData: (key: readonly unknown[]) => key[0] !== 'session',
  mutations: {
    previewDdl: (...args: Parameters<typeof previewDdl>) => previewDdl(...args),
    executeSql: (...args: Parameters<typeof executeSql>) => executeSql(...args),
  },
  structureQuery: ({ table }: { table: string }) => ({
    queryKey: ['structure', table],
    queryFn: async () => ({ columns: [], indexes: (indexes[table] ?? []).map((name) => ({ name, columns: [] })) }),
  }),
}))

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
  }
})
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  indexes = { logs: ['PRIMARY', 'idx_logs_level'], posts: ['PRIMARY'] }
  previewDdl.mockClear()
  executeSql.mockClear()
})
afterEach(cleanup)

const level = { db: 'shop', schema: null, table: 'logs', name: 'idx_logs_level', columns: ['level'] }

function mount(node: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}
function Console() {
  const plan = useVisualPlan('shop', undefined, SCOPE)
  return <>{plan.panel}</>
}

describe('triedIndexes', () => {
  it('remembers each index once per server, and forgets it', () => {
    rememberTried(SCOPE, level)
    rememberTried(SCOPE, level)
    expect(triedIndexes(SCOPE)).toEqual([level])
    expect(triedIndexes('postgres.other.5432')).toEqual([])
    forgetTried(SCOPE, { ...level, columns: [] })
    expect(triedIndexes(SCOPE)).toEqual([])
  })
})

describe('TriedIndexes', () => {
  it('offers to drop an index tried and still there, through the preview, and forgets it once dropped', async () => {
    rememberTried(SCOPE, level)
    mount(<Console />)
    const group = await screen.findByRole('region', { name: p.triedGroup })
    expect(group.textContent).toContain(p.triedItem('logs', 'idx_logs_level', ['level']))
    fireEvent.click(within(group).getByRole('button', { name: p.trialUndo('idx_logs_level') }))
    const dialog = await screen.findByRole('dialog', { name: locale.ddl.titles.dropIndex })
    expect(dialog.textContent).toContain(p.triedDropHint)
    expect(previewDdl).toHaveBeenCalledWith('shop', undefined, {
      op: 'dropIndex',
      table: 'logs',
      name: 'idx_logs_level',
    })
    // Nothing is dropped before it is confirmed.
    expect(executeSql).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
    await vi.waitFor(() => expect(triedIndexes(SCOPE)).toEqual([]))
    expect(executeSql).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: p.trialUndo('idx_logs_level') })).toBeNull()
    // The last one dropped still says so, and the focus is on what says it (not dropped on the page).
    const done = await screen.findByText(locale.ddl.executed(locale.ddl.titles.dropIndex))
    expect(document.activeElement?.contains(done) || done.contains(document.activeElement)).toBe(true)
  })

  it('forgets an index dropped elsewhere, and says nothing of other databases', async () => {
    rememberTried(SCOPE, { ...level, table: 'posts', name: 'idx_posts_x' })
    rememberTried(SCOPE, { ...level, db: 'other' })
    mount(<TriedIndexes scope={SCOPE} db="shop" />)
    await vi.waitFor(() => expect(triedIndexes(SCOPE)).toEqual([{ ...level, db: 'other' }]))
    expect(screen.queryByRole('region', { name: p.triedGroup })).toBeNull()
  })

  it('does not forget an index for a table read before it was made', async () => {
    rememberTried(SCOPE, level)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    // logs as it was read before the index (here, or in another tab): cached without it.
    client.setQueryData(['structure', 'logs'], { columns: [], indexes: [{ name: 'PRIMARY', columns: [] }] })
    mount(<TriedIndexes scope={SCOPE} db="shop" />, client)
    expect(await screen.findByRole('button', { name: p.trialUndo('idx_logs_level') })).toBeTruthy()
    expect(triedIndexes(SCOPE)).toEqual([level])
  })

  it('is shown in the SQL tab while no plan is open', async () => {
    mount(<Console />)
    expect(screen.queryByRole('region', { name: p.triedGroup })).toBeNull()
    // Tried from a plan (in this tab or another): it appears without a reload.
    rememberTried(SCOPE, level)
    expect(await screen.findByRole('region', { name: p.triedGroup })).toBeTruthy()
  })
})
