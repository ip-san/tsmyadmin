import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { PlanView } from './PlanView.tsx'
import { useVisualPlan } from './use-visual-plan.tsx'

const t = locale.planTour

/** The tables' estimated rows the list answers with; an error where it cannot be read. */
let estimated: Record<string, number> | Error
/** Holds the list back until it is let go. */
let listed: Promise<void>
/** What a measured run answers, and the runs asked for. */
let measuredRun: () => Promise<unknown>
const analyzePlan = vi.fn((..._: unknown[]) => measuredRun())
/** The DDL previewed and run (creating the index tried, dropping it again). */
const previewDdl = vi.fn(async (_db: string, _schema: unknown, op: { op: string; name: string }) => ({
  sql: [`${op.op} ${op.name}`],
}))
const executeSql = vi.fn(async (_db: string, body: { sql: string }) => [
  { kind: 'affected', sql: body.sql, affectedRows: 0, durationMs: 1 },
])
/** The condition the scan of logs filters by (none unless a test sets it). */
let condition: string | null

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
  detail: null,
  children: [],
}

vi.mock('@/lib/queries.ts', () => ({
  analyzePlan: (...args: unknown[]) => analyzePlan(...args),
  explainQuery: () => ({
    queryKey: ['explain'],
    queryFn: async () => ({ plan: { ...scan, detail: condition }, raw: '', rawTruncated: false }),
  }),
  sessionQuery: { queryKey: ['session'], queryFn: async () => ({ dialect: 'postgres' }) },
  isDatabaseData: (key: readonly unknown[]) => key[0] !== 'session',
  mutations: {
    previewDdl: (...args: Parameters<typeof previewDdl>) => previewDdl(...args),
    executeSql: (...args: Parameters<typeof executeSql>) => executeSql(...args),
  },
  foreignKeysQuery: () => ({ queryKey: ['keys'], queryFn: async () => [] }),
  structureQuery: () => ({
    queryKey: ['structure'],
    queryFn: async () => ({ columns: [{ name: 'id' }, { name: 'level' }], indexes: [] }),
  }),
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      await listed
      if (estimated instanceof Error) throw estimated
      return Object.entries(estimated).map(([name, rowEstimate]) => ({ name, kind: 'table', rowEstimate }))
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
  estimated = { logs: 10000 }
  listed = Promise.resolve()
  analyzePlan.mockClear()
  previewDdl.mockClear()
  executeSql.mockClear()
  condition = null
  measuredRun = async () => ({
    plan: { ...scan, actual: { rows: 1_200_000, loops: 1, ms: 950 } },
    raw: '',
    rawTruncated: false,
    measured: { ms: 1000 },
  })
})
afterEach(cleanup)

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <PlanView db="shop" sql="SELECT * FROM logs" onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

/** Opens the presentation once it can be, and goes to the scene that reads logs. */
async function readScene() {
  const open = await screen.findByRole('button', { name: t.open })
  await vi.waitFor(() => expect(open).toHaveProperty('disabled', false))
  fireEvent.click(open)
  fireEvent.keyDown(screen.getByRole('dialog', { name: t.dialog }), { key: 'ArrowRight' })
  expect(screen.getByRole('heading', { level: 3, name: t.readTitle('logs') })).toBeTruthy()
}

const p = locale.plan
const opener = async () => screen.findByRole('button', { name: p.measure })

describe('PlanView', () => {
  it("presents the plan with the tables' estimated rows: the size of each, and a gap that may be old statistics", async () => {
    mount()
    await readScene()
    expect(screen.getByText(locale.designReading.rows('logs', 10000))).toBeTruthy()
    expect(screen.getByText(t.staleStats('logs', 50000, 10000))).toBeTruthy()
  })

  it('waits for the list of tables before it opens: the scenes are told as they were when it opened', async () => {
    const held = Promise.withResolvers<void>()
    listed = held.promise
    const letGo = () => held.resolve()
    mount()
    const open = await screen.findByRole('button', { name: t.open })
    // The index columns are read; the list is not.
    await new Promise((r) => setTimeout(r, 20))
    expect(open).toHaveProperty('disabled', true)
    // The presentation's own status line (the measuring has one too).
    expect(screen.getAllByRole('status').map((e) => e.textContent)).toContain(t.waiting)
    letGo()
    await vi.waitFor(() => expect(open).toHaveProperty('disabled', false))
  })

  it('presents it without them where the list of tables cannot be read', async () => {
    estimated = new Error('no list')
    mount()
    await readScene()
    expect(screen.queryByText(t.staleStats('logs', 50000, 10000))).toBeNull()
    expect(screen.queryByText(locale.designReading.rows('logs', 10000))).toBeNull()
  })

  describe('run and measure', () => {
    it('asks first, runs once however often pressed, and shows each step beside its estimate', async () => {
      mount()
      fireEvent.click(await opener())
      const run = screen.getByRole('button', { name: p.measureRun })
      expect(screen.getByRole('group', { name: p.measureGroup }).textContent).toContain(p.measureConfirm(30))
      expect(document.activeElement).toBe(run)
      expect(analyzePlan).not.toHaveBeenCalled()
      // Pressed twice in one frame: one run.
      fireEvent.click(run)
      fireEvent.click(run)
      expect(analyzePlan).toHaveBeenCalledTimes(1)
      expect(analyzePlan).toHaveBeenCalledWith('shop', undefined, 'SELECT * FROM logs')
      await screen.findByText(p.measured(p.duration(1000)))
      expect(screen.getByText(new RegExp(p.actual(1_200_000, 1, p.duration(950)).replace(/[()]/g, '.')))).toBeTruthy()
      expect(screen.getByText(new RegExp(p.off(24, true)))).toBeTruthy()
      expect(screen.getByText(p.notesMeasured)).toBeTruthy()
      // The question is gone; the focus is back on the button that asked it.
      expect(screen.queryByRole('group', { name: p.measureGroup })).toBeNull()
      expect(document.activeElement).toBe(await opener())
    })

    it('runs nothing when the question is put away, and says why a run failed, keeping the estimate', async () => {
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureCancel }))
      expect(analyzePlan).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(await opener())
      measuredRun = async () => {
        throw new Error('The statement was stopped before it finished (its time ran out)')
      }
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      await screen.findByText(/its time ran out/)
      expect(screen.getByText(p.notes)).toBeTruthy()
    })

    it('shows nothing measured of the last statement under the next one drawn', async () => {
      function Console() {
        const plan = useVisualPlan('shop', undefined)
        return (
          <>
            {['SELECT * FROM logs', 'SELECT id FROM logs'].map((sql) => (
              <button key={sql} type="button" onClick={() => plan.show(sql)}>
                {sql}
              </button>
            ))}
            {plan.panel}
          </>
        )
      }
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={client}>
          <Console />
        </QueryClientProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'SELECT * FROM logs' }))
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      await screen.findByText(p.notesMeasured)
      // Another statement drawn in the same panel: its estimate, not the measured run of the one before.
      fireEvent.click(screen.getByRole('button', { name: 'SELECT id FROM logs' }))
      await screen.findByText(p.notes)
      expect(screen.queryByText(p.notesMeasured)).toBeNull()
      expect(screen.queryByText(p.measured(p.duration(1000)))).toBeNull()
    })
  })

  describe('trying an index', () => {
    /** The plan of logs measured: in full before, through the index after (or in full still). */
    const run = (index: string | null, ms: number) => async () => ({
      plan: {
        ...scan,
        detail: condition,
        access: index ? 'lookup' : 'fullScan',
        index,
        actual: { rows: index ? 12 : 50000, loops: 1, ms },
      },
      raw: '',
      rawTruncated: false,
      measured: { ms },
    })

    async function measured() {
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      return screen.findByRole('region', { name: p.trialGroup })
    }

    it('offers the index the plan suggests once measured, makes it through the preview, and sets the runs side by side', async () => {
      condition = '(level = 3)'
      measuredRun = run(null, 400)
      mount()
      const trial = await measured()
      const tryIt = await screen.findByRole('button', { name: p.trialTry('logs', ['level']) })
      expect(screen.getByText(p.trialWhy.filter('logs'))).toBeTruthy()
      fireEvent.click(tryIt)
      // Nothing is made before the preview is confirmed; the dialog says the statement runs again.
      const dialog = await screen.findByRole('dialog', { name: locale.ddl.titles.addIndex })
      expect(dialog.textContent).toContain(p.trialHint)
      expect(previewDdl).toHaveBeenCalledWith('shop', undefined, {
        op: 'addIndex',
        table: 'logs',
        name: 'idx_logs_level',
        columns: ['level'],
        unique: false,
      })
      expect(executeSql).not.toHaveBeenCalled()
      measuredRun = run('idx_logs_level', 4)
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      expect(await screen.findByText(p.trialTotal(p.duration(400), p.duration(4), 100))).toBeTruthy()
      expect(trial.textContent).toContain(
        `logs: ${p.trialRead(null, 50000, p.duration(400))} → ${p.trialRead('idx_logs_level', 12, p.duration(4))}`
      )
      expect(screen.queryByText(p.trialUnused('idx_logs_level'))).toBeNull()
      expect(analyzePlan).toHaveBeenCalledTimes(2)
      // The run before stays the one compared with: no measuring it over while the index is there.
      expect(screen.queryByRole('button', { name: p.measure })).toBeNull()
      // The presentation tells the run after, and ends with it beside the run before: logs read in full, then by the index.
      fireEvent.click(await screen.findByRole('button', { name: t.open }))
      const tour = screen.getByRole('dialog', { name: t.dialog })
      fireEvent.click(within(tour).getByRole('button', { name: new RegExp(`^\\d+\\. ${t.trialAfterTitle}$`) }))
      expect(screen.getByRole('heading', { level: 3, name: t.trialAfterTitle })).toBeTruthy()
      expect(tour.textContent).toContain(t.trialAfter('logs', p.trialRead('idx_logs_level', 12, p.duration(4)), true))
      expect(tour.textContent).toContain(t.chapters.trial)
      fireEvent.click(within(tour).getByRole('button', { name: locale.tour.close }))
      // Dropped again through the preview: the comparison is put away.
      fireEvent.click(screen.getByRole('button', { name: p.trialUndo('idx_logs_level') }))
      expect((await screen.findByRole('dialog', { name: locale.ddl.titles.dropIndex })).textContent).toContain(
        p.trialUndoHint
      )
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      await vi.waitFor(() => expect(screen.queryByText(p.trialTotal(p.duration(400), p.duration(4), 100))).toBeNull())
      expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
        op: 'dropIndex',
        table: 'logs',
        name: 'idx_logs_level',
      })
      expect(screen.getByRole('button', { name: p.measure })).toBeTruthy()
    })

    it('says so where the server did not use the index made', async () => {
      condition = '(level = 3)'
      measuredRun = run(null, 400)
      mount()
      await measured()
      fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      expect(await screen.findByText(p.trialUnused('idx_logs_level'))).toBeTruthy()
    })

    it('says there is nothing to try where no condition names a column', async () => {
      mount()
      await measured()
      expect(await screen.findByText(p.trialNone)).toBeTruthy()
      // Measured, nothing tried: the presentation has no before and after.
      fireEvent.click(await screen.findByRole('button', { name: t.open }))
      const tour = screen.getByRole('dialog', { name: t.dialog })
      expect(within(tour).queryByRole('button', { name: new RegExp(`\\. ${t.trialBeforeTitle}$`) })).toBeNull()
      expect(within(tour).getAllByRole('button', { name: new RegExp(`\\. ${t.measuredTitle}$`) })).toHaveLength(1)
    })

    it('offers nothing to try before the statement is measured', async () => {
      condition = '(level = 3)'
      mount()
      await opener()
      expect(screen.queryByRole('region', { name: p.trialGroup })).toBeNull()
    })
  })
})
