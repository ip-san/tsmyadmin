import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TRIED_INDEX_COMMENT } from '@tsmyadmin/shared'
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
/** The indexes a failed build left unusable on each table. */
let unusable: Record<string, string[]>
/** The structure cannot be read now. */
let unreadable: boolean
/** The indexes of the database that have a comment, as the server lists them (null: the list cannot be read). */
let commented: { table: string; name: string; comment: string; partitioned: boolean }[] | null
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
  indexCommentsQuery: () => ({
    queryKey: ['index-comments'],
    queryFn: async () => {
      if (commented === null) throw new Error('cannot list')
      return commented
    },
  }),
  structureQuery: ({ table }: { table: string }) => ({
    queryKey: ['structure', table],
    queryFn: async () => {
      if (unreadable) throw new Error('cannot read')
      return {
        columns: [],
        indexes: (indexes[table] ?? []).map((name) => ({ name, columns: [] })),
        unusableIndexes: unusable[table] ?? [],
      }
    },
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
  unreadable = false
  commented = []
  unusable = {}
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

  it('says an index tried was left unusable, and drops it without stopping writes', async () => {
    rememberTried(SCOPE, { ...level, name: 'idx_logs_left', online: true })
    unusable = { logs: ['idx_logs_left'] }
    mount(<TriedIndexes scope={SCOPE} db="shop" />)
    const group = await screen.findByRole('region', { name: p.triedGroup })
    expect(group.textContent).toContain(p.trialLeftover('logs', 'idx_logs_left'))
    fireEvent.click(within(group).getByRole('button', { name: p.trialUndo('idx_logs_left') }))
    await screen.findByRole('dialog', { name: locale.ddl.titles.dropIndex })
    expect(previewDdl).toHaveBeenCalledWith('shop', undefined, {
      op: 'dropIndex',
      table: 'logs',
      name: 'idx_logs_left',
      online: true,
    })
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

  it('does not forget an index where its table cannot be read again', async () => {
    rememberTried(SCOPE, level)
    unreadable = true
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['structure', 'logs'], { columns: [], indexes: [{ name: 'PRIMARY', columns: [] }] })
    mount(<TriedIndexes scope={SCOPE} db="shop" />, client)
    await vi.waitFor(() => expect(client.getQueryState(['structure', 'logs'])?.status).toBe('error'))
    expect(triedIndexes(SCOPE)).toEqual([level])
  })

  it('is shown in the SQL tab while no plan is open', async () => {
    mount(<Console />)
    expect(screen.queryByRole('region', { name: p.triedGroup })).toBeNull()
    // Tried from a plan (in this tab or another): it appears without a reload.
    rememberTried(SCOPE, level)
    expect(await screen.findByRole('region', { name: p.triedGroup })).toBeTruthy()
  })

  it('lists the indexes marked on the server as tried, though not remembered here, and drops each as it can be', async () => {
    commented = [
      { table: 'logs', name: 'idx_logs_b', comment: TRIED_INDEX_COMMENT, partitioned: false },
      { table: 'events', name: 'idx_events_d', comment: TRIED_INDEX_COMMENT, partitioned: true },
      // Another comment: not one tried.
      { table: 'logs', name: 'idx_logs_designed', comment: 'by hand', partitioned: false },
    ]
    mount(<TriedIndexes scope={SCOPE} db="shop" />)
    const group = await screen.findByRole('region', { name: p.triedGroup })
    expect(group.textContent).toContain(p.trialBefore('logs', 'idx_logs_b'))
    expect(group.textContent).toContain(p.trialBefore('events', 'idx_events_d'))
    expect(group.textContent).not.toContain('idx_logs_designed')
    fireEvent.click(within(group).getByRole('button', { name: p.trialUndo('idx_logs_b') }))
    await screen.findByRole('dialog', { name: locale.ddl.titles.dropIndex })
    expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
      op: 'dropIndex',
      table: 'logs',
      name: 'idx_logs_b',
      online: true,
    })
    fireEvent.click(screen.getByRole('button', { name: locale.common.cancel }))
    // A partitioned parent's cannot be dropped without stopping writes (PostgreSQL).
    fireEvent.click(within(group).getByRole('button', { name: p.trialUndo('idx_events_d') }))
    await vi.waitFor(() =>
      expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
        op: 'dropIndex',
        table: 'events',
        name: 'idx_events_d',
      })
    )
  })

  it('does not list one marked on the server again once dropped from here, though the marks were read before', async () => {
    commented = [{ table: 'logs', name: 'idx_logs_b', comment: TRIED_INDEX_COMMENT, partitioned: false }]
    mount(<TriedIndexes scope={SCOPE} db="shop" />)
    const group = await screen.findByRole('region', { name: p.triedGroup })
    fireEvent.click(within(group).getByRole('button', { name: p.trialUndo('idx_logs_b') }))
    fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
    await screen.findByText(locale.ddl.executed(locale.ddl.titles.dropIndex))
    expect(screen.queryByRole('button', { name: p.trialUndo('idx_logs_b') })).toBeNull()
  })

  it('lists one remembered here and marked on the server once, as remembered (with its columns)', async () => {
    rememberTried(SCOPE, level)
    commented = [{ table: 'logs', name: 'idx_logs_level', comment: TRIED_INDEX_COMMENT, partitioned: false }]
    mount(<TriedIndexes scope={SCOPE} db="shop" />)
    const group = await screen.findByRole('region', { name: p.triedGroup })
    expect(group.textContent).toContain(p.triedItem('logs', 'idx_logs_level', ['level']))
    expect(within(group).getAllByRole('button', { name: p.trialUndo('idx_logs_level') })).toHaveLength(1)
  })

  it('says the list of the server could not be read, with a retry, rather than nothing', async () => {
    commented = null
    mount(<TriedIndexes scope={SCOPE} db="shop" />)
    const group = await screen.findByRole('region', { name: p.triedGroup })
    expect(group.textContent).toContain('cannot list')
    commented = [{ table: 'logs', name: 'idx_logs_b', comment: TRIED_INDEX_COMMENT, partitioned: false }]
    fireEvent.click(within(group).getByRole('button', { name: locale.common.retry }))
    expect(await within(group).findByText(p.trialBefore('logs', 'idx_logs_b'))).toBeTruthy()
  })
})
