import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { PlanView } from './PlanView.tsx'

/** Taking a table's statistics again from its plan (the rest is in PlanView.test.tsx). */

const p = locale.plan
/** The rows the plan expects of logs, and the table list's estimate: both as the server reads them now. */
let planRows: number
let listRows: number
/** Holds the table list back until it is let go. */
let listed: Promise<void>
const scan = (): PlanNode => ({
  op: 'Seq Scan',
  table: 'logs',
  alias: null,
  index: null,
  indexColumns: [],
  access: 'fullScan',
  covering: false,
  estRows: planRows,
  cost: null,
  detail: null,
  children: [],
})
const analyzePlan = vi.fn(async (..._: unknown[]) => ({
  plan: { ...scan(), actual: { rows: 50_000, loops: 1, ms: 40 } },
  raw: '',
  rawTruncated: false,
  measured: { ms: 40 },
}))
const previewDdl = vi.fn(async (_db: string, _schema: unknown, op: { op: string; table: string }) => ({
  sql: [`ANALYZE ${op.table}`],
}))
/** Running the ANALYZE: the statistics are the table's own from then on. */
const executeSql = vi.fn(async (_db: string, body: { sql: string }) => {
  planRows = 60_000
  listRows = 60_000
  return [{ kind: 'affected', sql: body.sql, affectedRows: 0, durationMs: 1 }]
})

vi.mock('@/lib/queries.ts', () => ({
  analyzePlan: (...args: unknown[]) => analyzePlan(...args),
  hypotheticalPlan: async () => ({}),
  explainQuery: () => ({
    queryKey: ['explain'],
    queryFn: async () => ({ plan: scan(), raw: '', rawTruncated: false }),
  }),
  sessionQuery: { queryKey: ['session'], queryFn: async () => ({ dialect: 'postgres' }) },
  isDatabaseData: (key: readonly unknown[]) => key[0] !== 'session',
  mutations: {
    previewDdl: (...args: Parameters<typeof previewDdl>) => previewDdl(...args),
    executeSql: (...args: Parameters<typeof executeSql>) => executeSql(...args),
    cancelSql: async () => ({ cancelled: true }),
  },
  foreignKeysQuery: () => ({ queryKey: ['keys'], queryFn: async () => [] }),
  structureQuery: () => ({
    queryKey: ['structure'],
    queryFn: async () => ({ columns: [{ name: 'id' }, { name: 'level' }], indexes: [], unusableIndexes: [] }),
  }),
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      await listed
      return [{ name: 'logs', kind: 'table', rowEstimate: listRows }]
    },
  }),
}))

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
  }
})
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  planRows = 50_000
  listRows = 10_000
  listed = Promise.resolve()
  analyzePlan.mockClear()
  previewDdl.mockClear()
  executeSql.mockClear()
})
afterEach(cleanup)

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PlanView db="shop" sql="SELECT * FROM logs" scope="postgres.db.5432" onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

async function refresh() {
  fireEvent.click(await screen.findByRole('button', { name: p.statsRefresh('logs') }))
  const dialog = await screen.findByRole('dialog', { name: locale.ddl.titles.maintainTable })
  expect(dialog.textContent).toContain(p.statsHint)
  expect(previewDdl).toHaveBeenCalledWith('shop', undefined, { op: 'maintainTable', table: 'logs', action: 'analyze' })
  expect(executeSql).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
}

describe('PlanView, taking statistics again', () => {
  it('offers it where the plan and the table list are far apart, and says what the plan expects before and after', async () => {
    mount()
    expect(await screen.findByText(p.statsList('logs', 50_000, 10_000))).toBeTruthy()
    const held = Promise.withResolvers<void>()
    listed = held.promise
    await refresh()
    expect(await screen.findByText(p.statsDone('logs', 50_000, 60_000, false))).toBeTruthy()
    // The table list as it was before is not set against the plan read anew: the list read after it is waited for.
    expect(screen.queryByText(p.statsList('logs', 60_000, 10_000))).toBeNull()
    await act(async () => held.resolve())
    // Read anew under the statistics taken: the table list no longer differs, and the table stays listed as taken.
    expect(screen.queryByText(p.statsList('logs', 60_000, 10_000))).toBeNull()
    expect(screen.getByText(p.statsTaken('logs'))).toBeTruthy()
    expect(screen.getByRole('button', { name: p.statsRefresh('logs') })).toBeTruthy()
  })

  it('offers nothing where the estimates agree', async () => {
    planRows = 10_500
    mount()
    await screen.findByRole('button', { name: p.measure })
    expect(screen.queryByRole('region', { name: p.statsGroup })).toBeNull()
  })

  it('puts away the run measured under the old statistics, and the index trial that compared with it', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: p.measure }))
    fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
    await screen.findByText(p.measured(p.duration(40)))
    expect(screen.getByRole('region', { name: p.trialGroup })).toBeTruthy()
    await refresh()
    expect(await screen.findByText(p.statsDone('logs', 50_000, 60_000, true))).toBeTruthy()
    expect(screen.queryByText(p.measured(p.duration(40)))).toBeNull()
    expect(screen.queryByRole('region', { name: p.trialGroup })).toBeNull()
    expect(screen.getByText(p.notes)).toBeTruthy()
  })
})
