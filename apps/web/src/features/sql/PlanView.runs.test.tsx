import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { PlanView } from './PlanView.tsx'

/** Measuring a plan several times in a row, before an index is tried and after (the rest is in PlanView.test.tsx). */

const p = locale.plan
const scan: PlanNode = {
  op: 'Seq Scan',
  table: 'logs',
  alias: null,
  index: null,
  indexColumns: [],
  access: 'fullScan',
  covering: false,
  estRows: 50000,
  cost: null,
  detail: '(level = 3)',
  children: [],
}
/** What each measured run answers, in turn. */
let runs: (() => Promise<unknown>)[]
const analyzePlan = vi.fn((..._: unknown[]) => (runs.shift() ?? run(null, 1))())
const previewDdl = vi.fn(async (_db: string, _schema: unknown, op: { op: string; name: string }) => ({
  sql: [`${op.op} ${op.name}`],
}))
const executeSql = vi.fn(async (_db: string, body: { sql: string }) => [
  { kind: 'affected', sql: body.sql, affectedRows: 0, durationMs: 1 },
])

vi.mock('@/lib/queries.ts', () => ({
  analyzePlan: (...args: unknown[]) => analyzePlan(...args),
  hypotheticalPlan: async () => ({}),
  explainQuery: () => ({
    queryKey: ['explain'],
    queryFn: async () => ({ plan: { ...scan, cost: 1693 }, raw: '', rawTruncated: false }),
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
    queryFn: async () => [{ name: 'logs', kind: 'table', rowEstimate: 50000 }],
  }),
}))

/** The plan of logs measured: in full before, through the index after. */
function run(index: string | null, ms: number) {
  return async () => ({
    plan: { ...scan, access: index ? 'lookup' : 'fullScan', index, actual: { rows: index ? 12 : 50000, loops: 1, ms } },
    raw: '',
    rawTruncated: false,
    measured: { ms },
  })
}

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
  analyzePlan.mockClear()
})
afterEach(cleanup)

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PlanView db="shop" sql="SELECT * FROM logs" scope="postgres.db.5432" onClose={vi.fn()} />
    </QueryClientProvider>
  )
}
const opener = async () => screen.findByRole('button', { name: p.measure })

describe('PlanView, measured several times', () => {
  it('measures as many times as chosen, before and after alike, and compares the medians', async () => {
    runs = [run(null, 400), run(null, 10), run(null, 500)]
    mount()
    fireEvent.change(await screen.findByLabelText(p.measureRuns), { target: { value: '3' } })
    fireEvent.click(await opener())
    expect(screen.getByRole('group', { name: p.measureGroup }).textContent).toContain(p.measureConfirm(30, 3))
    fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
    // The tree is the last run; the time said is the median, with the fastest and the slowest.
    await screen.findByText(p.measuredRuns(3, p.duration(400), p.duration(10), p.duration(500)))
    expect(analyzePlan).toHaveBeenCalledTimes(3)
    // Chosen otherwise since, the run after is still measured as many times as the run before was.
    fireEvent.change(screen.getByLabelText(p.measureRuns), { target: { value: '5' } })
    fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
    runs.push(run('idx_logs_level', 4), run('idx_logs_level', 300), run('idx_logs_level', 5))
    fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
    // Measured again as many times, and compared by the medians (400 and 5), not by the last runs (500 and 5).
    expect(await screen.findByText(p.trialTotal(p.duration(400), p.duration(5), 80, [3, 3]))).toBeTruthy()
    expect(analyzePlan).toHaveBeenCalledTimes(6)
  })
})
