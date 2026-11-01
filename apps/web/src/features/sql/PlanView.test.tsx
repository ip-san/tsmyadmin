import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { PlanView } from './PlanView.tsx'
import { triedIndexes } from './tried-indexes.ts'
import { useVisualPlan } from './use-visual-plan.tsx'

const t = locale.planTour
const SCOPE = 'postgres.db.5432'

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
/** The stops asked of a measured run: answered as the server would, or failed. */
let cancelled: () => Promise<{ cancelled: boolean }>
const cancelSql = vi.fn((_db: string, _id: string) => cancelled())
const executeSql = vi.fn(async (_db: string, body: { sql: string }) => [
  { kind: 'affected', sql: body.sql, affectedRows: 0, durationMs: 1 },
])
/** The condition the scan of logs filters by (none unless a test sets it). */
let condition: string | null
/** The indexes a failed build left unusable on logs. */
let leftover: string[]
/** Whether the estimate says the server can plan with an index assumed (absent: it has no such thing). */
let canAssume: boolean | undefined
/** What the plan with an index assumed answers. */
let assumedRun: () => Promise<unknown>
const hypotheticalPlan = vi.fn((..._: unknown[]) => assumedRun())

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
  hypotheticalPlan: (...args: unknown[]) => hypotheticalPlan(...args),
  explainQuery: () => ({
    queryKey: ['explain'],
    queryFn: async () => ({
      plan: { ...scan, detail: condition, cost: 1693 },
      raw: '',
      rawTruncated: false,
      ...(canAssume === undefined ? {} : { canAssume }),
    }),
  }),
  sessionQuery: { queryKey: ['session'], queryFn: async () => ({ dialect: 'postgres' }) },
  isDatabaseData: (key: readonly unknown[]) => key[0] !== 'session',
  mutations: {
    previewDdl: (...args: Parameters<typeof previewDdl>) => previewDdl(...args),
    executeSql: (...args: Parameters<typeof executeSql>) => executeSql(...args),
    cancelSql: (...args: Parameters<typeof cancelSql>) => cancelSql(...args),
  },
  foreignKeysQuery: () => ({ queryKey: ['keys'], queryFn: async () => [] }),
  structureQuery: () => ({
    queryKey: ['structure'],
    queryFn: async () => ({ columns: [{ name: 'id' }, { name: 'level' }], indexes: [], unusableIndexes: leftover }),
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
  vi.stubGlobal('localStorage', memoryStorage())
  estimated = { logs: 10000 }
  listed = Promise.resolve()
  analyzePlan.mockClear()
  cancelSql.mockClear()
  cancelled = async () => ({ cancelled: true })
  previewDdl.mockClear()
  executeSql.mockClear()
  condition = null
  leftover = []
  canAssume = undefined
  hypotheticalPlan.mockClear()
  assumedRun = async () => ({
    plan: { ...scan, detail: condition, access: 'range', index: 'idx_logs_level', estRows: 50, cost: 8.3 },
    raw: '',
    rawTruncated: false,
    assumed: ['idx_logs_level'],
  })
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
      <PlanView db="shop" sql="SELECT * FROM logs" scope={SCOPE} onClose={vi.fn()} />
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
      expect(analyzePlan).toHaveBeenCalledWith('shop', undefined, 'SELECT * FROM logs', expect.any(String))
      await screen.findByText(p.measured(p.duration(1000)))
      expect(screen.getByText(new RegExp(p.actual(1_200_000, 1, p.duration(950)).replace(/[()]/g, '.')))).toBeTruthy()
      expect(screen.getByText(new RegExp(p.off(24, true)))).toBeTruthy()
      expect(screen.getByText(p.notesMeasured)).toBeTruthy()
      // The question is gone; the focus is back on the button that asked it.
      expect(screen.queryByRole('group', { name: p.measureGroup })).toBeNull()
      expect(document.activeElement).toBe(await opener())
    })

    it('stops a run on a press, once however often pressed, and says it was stopped, not that it failed', async () => {
      let fail: (err: Error) => void = () => undefined
      measuredRun = () =>
        new Promise((_, reject) => {
          fail = reject
        })
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      const stop = screen.getByRole('button', { name: p.measureCancel })
      fireEvent.click(stop)
      fireEvent.click(stop)
      // The server's cancel, for the run under its own id.
      expect(cancelSql).toHaveBeenCalledTimes(1)
      expect(cancelSql).toHaveBeenCalledWith('shop', analyzePlan.mock.calls[0]?.[3])
      expect(await screen.findByText(p.measureStopping)).toBeTruthy()
      expect(stop.getAttribute('aria-disabled')).toBe('true')
      fail(new Error('The statement was stopped'))
      expect(await screen.findByText(p.measureStopped)).toBeTruthy()
      expect(screen.queryByText('The statement was stopped')).toBeNull()
      expect(screen.getByText(p.notes)).toBeTruthy()
      expect(document.activeElement).toBe(await opener())
    })

    it('says why a stop did not reach the server, and can stop again', async () => {
      let fail: (err: Error) => void = () => undefined
      measuredRun = () =>
        new Promise((_, reject) => {
          fail = reject
        })
      cancelled = async () => {
        throw new Error('no connection')
      }
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      fireEvent.click(screen.getByRole('button', { name: p.measureCancel }))
      expect(await screen.findByText(/no connection/)).toBeTruthy()
      cancelled = async () => ({ cancelled: true })
      fireEvent.click(screen.getByRole('button', { name: p.measureCancel }))
      expect(cancelSql).toHaveBeenCalledTimes(2)
      fail(new Error('The statement was stopped'))
      expect(await screen.findByText(p.measureStopped)).toBeTruthy()
    })

    it('says a failure of its own where the server had nothing to stop, and can be stopped again', async () => {
      let fail: (err: Error) => void = () => undefined
      measuredRun = () =>
        new Promise((_, reject) => {
          fail = reject
        })
      cancelled = async () => ({ cancelled: false })
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      const stop = screen.getByRole('button', { name: p.measureCancel })
      fireEvent.click(stop)
      await vi.waitFor(() => expect(stop.getAttribute('aria-disabled')).toBeNull())
      fail(new Error('its time ran out'))
      expect(await screen.findByText(/its time ran out/)).toBeTruthy()
      expect(screen.queryByText(p.measureStopped)).toBeNull()
    })

    it('waits for what the server says of a stop before calling a failed run stopped', async () => {
      let fail: (err: Error) => void = () => undefined
      measuredRun = () =>
        new Promise((_, reject) => {
          fail = reject
        })
      let answer: (r: { cancelled: boolean }) => void = () => undefined
      cancelled = () =>
        new Promise((resolve) => {
          answer = resolve
        })
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      fireEvent.click(screen.getByRole('button', { name: p.measureCancel }))
      // The run fails of its own before the server answers that it had nothing to stop.
      fail(new Error('its time ran out'))
      answer({ cancelled: false })
      expect(await screen.findByText(/its time ran out/)).toBeTruthy()
      expect(screen.queryByText(p.measureStopped)).toBeNull()
    })

    it('stops the run when the plan is closed while it runs', async () => {
      measuredRun = () => new Promise(() => undefined)
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      expect(cancelSql).not.toHaveBeenCalled()
      cleanup()
      expect(cancelSql).toHaveBeenCalledWith('shop', analyzePlan.mock.calls[0]?.[3])
    })

    it('puts away why a stop did not reach the server when the question is put away', async () => {
      let done: (r: unknown) => void = () => undefined
      measuredRun = () =>
        new Promise((resolve) => {
          done = resolve
        })
      cancelled = async () => {
        throw new Error('no connection')
      }
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      fireEvent.click(screen.getByRole('button', { name: p.measureCancel }))
      expect(await screen.findByText(/no connection/)).toBeTruthy()
      // The run ends as it would; asked again and put away, the stop's failure is no longer what is shown.
      done({ plan: scan, raw: '', rawTruncated: false, measured: { ms: 5 } })
      await screen.findByText(p.measured(p.duration(5)))
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureCancel }))
      expect(screen.queryByText(/no connection/)).toBeNull()
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
        const plan = useVisualPlan('shop', undefined, SCOPE)
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
      expect(dialog.textContent).toContain(p.trialHint(true))
      expect(previewDdl).toHaveBeenCalledWith('shop', undefined, {
        op: 'addIndex',
        table: 'logs',
        name: 'idx_logs_level',
        columns: ['level'],
        unique: false,
        online: true,
      })
      expect(executeSql).not.toHaveBeenCalled()
      measuredRun = run('idx_logs_level', 4)
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      expect(await screen.findByText(p.trialTotal(p.duration(400), p.duration(4), 100))).toBeTruthy()
      expect(trial.textContent).toContain(
        `logs: ${p.trialRead(null, 50000, p.duration(400))} → ${p.trialRead('idx_logs_level', 12, p.duration(4))}`
      )
      expect(screen.queryByText(p.trialUnused('idx_logs_level'))).toBeNull()
      // Remembered for the SQL tab, until dropped.
      expect(triedIndexes(SCOPE)).toEqual([
        { db: 'shop', schema: null, table: 'logs', name: 'idx_logs_level', columns: ['level'], online: true },
      ])
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
      expect(triedIndexes(SCOPE)).toEqual([])
      expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
        op: 'dropIndex',
        table: 'logs',
        name: 'idx_logs_level',
        online: true,
      })
      expect(screen.getByRole('button', { name: p.measure })).toBeTruthy()
    })

    it('makes and drops it the plain way where building without stopping writes is turned off', async () => {
      condition = '(level = 3)'
      measuredRun = run(null, 400)
      mount()
      await measured()
      fireEvent.click(screen.getByRole('checkbox', { name: p.trialOnline }))
      fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
      const dialog = await screen.findByRole('dialog', { name: locale.ddl.titles.addIndex })
      expect(dialog.textContent).toContain(p.trialHint(false))
      expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
        op: 'addIndex',
        table: 'logs',
        name: 'idx_logs_level',
        columns: ['level'],
        unique: false,
        online: false,
      })
      measuredRun = run('idx_logs_level', 4)
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      fireEvent.click(await screen.findByRole('button', { name: p.trialUndo('idx_logs_level') }))
      await screen.findByRole('dialog', { name: locale.ddl.titles.dropIndex })
      expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
        op: 'dropIndex',
        table: 'logs',
        name: 'idx_logs_level',
        online: false,
      })
    })

    it('says an index a failed build left unusable, and drops it without stopping writes', async () => {
      condition = '(level = 3)'
      measuredRun = run(null, 400)
      mount()
      const trial = await measured()
      fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
      executeSql.mockImplementationOnce(async (_db, body) => {
        // PostgreSQL keeps what the concurrent build made so far.
        leftover = ['idx_logs_level']
        return [
          { kind: 'error', sql: body.sql, line: 1, statement: 0, message: 'canceling statement due to timeout' },
        ] as never
      })
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      expect(await screen.findByText(/canceling statement due to timeout/)).toBeTruthy()
      // Not remembered as tried: the name may be another's index. The server says what was left.
      expect(triedIndexes(SCOPE)).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: locale.common.cancel }))
      expect(await within(trial).findByText(p.trialLeftover('logs', 'idx_logs_level'))).toBeTruthy()
      fireEvent.click(within(trial).getByRole('button', { name: p.trialUndo('idx_logs_level') }))
      await screen.findByRole('dialog', { name: locale.ddl.titles.dropIndex })
      expect(previewDdl).toHaveBeenLastCalledWith('shop', undefined, {
        op: 'dropIndex',
        table: 'logs',
        name: 'idx_logs_level',
        online: true,
      })
      leftover = []
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      await vi.waitFor(() => expect(within(trial).queryByText(p.trialLeftover('logs', 'idx_logs_level'))).toBeNull())
      expect(triedIndexes(SCOPE)).toEqual([])
    })

    it('keeps the index tried when a leftover beside it is dropped', async () => {
      condition = '(level = 3)'
      leftover = ['idx_logs_old']
      measuredRun = run(null, 400)
      mount()
      const trial = await measured()
      fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
      measuredRun = run('idx_logs_level', 4)
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      const total = p.trialTotal(p.duration(400), p.duration(4), 100)
      expect(await screen.findByText(total)).toBeTruthy()
      fireEvent.click(within(trial).getByRole('button', { name: p.trialUndo('idx_logs_old') }))
      leftover = []
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      await vi.waitFor(() => expect(within(trial).queryByText(p.trialLeftover('logs', 'idx_logs_old'))).toBeNull())
      expect(screen.getByText(total)).toBeTruthy()
      expect(within(trial).getByRole('button', { name: p.trialUndo('idx_logs_level') })).toBeTruthy()
      expect(triedIndexes(SCOPE).map((x) => x.name)).toEqual(['idx_logs_level'])
    })

    it('stops measuring again on a press, keeping the index, and gives the focus to measuring again', async () => {
      condition = '(level = 3)'
      measuredRun = run(null, 400)
      mount()
      const trial = await measured()
      let fail: (err: Error) => void = () => undefined
      measuredRun = () =>
        new Promise((_, reject) => {
          fail = reject
        })
      fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      const stop = await within(trial).findByRole('button', { name: p.trialStop })
      stop.focus()
      fireEvent.click(stop)
      fireEvent.click(stop)
      expect(cancelSql).toHaveBeenCalledTimes(1)
      expect(cancelSql).toHaveBeenCalledWith('shop', analyzePlan.mock.calls[1]?.[3])
      expect(await within(trial).findByText(p.measureStopping)).toBeTruthy()
      fail(new Error('The statement was stopped'))
      expect(await within(trial).findByText(p.trialStopped)).toBeTruthy()
      expect(within(trial).queryByRole('button', { name: p.trialStop })).toBeNull()
      expect(within(trial).queryByText('The statement was stopped')).toBeNull()
      expect(document.activeElement).toBe(within(trial).getByRole('button', { name: p.trialAgain }))
      // The index is there all the same: it can be measured again, or dropped.
      expect(within(trial).getByRole('button', { name: p.trialUndo('idx_logs_level') })).toBeTruthy()
      expect(triedIndexes(SCOPE)).toHaveLength(1)
    })

    it('puts away the last failure as it measures again', async () => {
      condition = '(level = 3)'
      measuredRun = run(null, 400)
      mount()
      const trial = await measured()
      measuredRun = async () => {
        throw new Error('its time ran out')
      }
      fireEvent.click(await screen.findByRole('button', { name: p.trialTry('logs', ['level']) }))
      fireEvent.click(await screen.findByRole('button', { name: locale.ddl.execute }))
      expect(await within(trial).findByText(/its time ran out/)).toBeTruthy()
      measuredRun = () => new Promise(() => undefined)
      fireEvent.click(within(trial).getByRole('button', { name: p.trialAgain }))
      expect(await within(trial).findByText(p.trialMeasuring)).toBeTruthy()
      expect(within(trial).queryByText(/its time ran out/)).toBeNull()
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

  describe('trying an index without building it', () => {
    const group = () => screen.findByRole('region', { name: p.assumeGroup })
    const assumeIt = () => screen.findByRole('button', { name: p.assumeTry('logs', ['level']) })
    const diagram = () => screen.getByText(p.diagram, { selector: 'figcaption' }).closest('figure') as HTMLElement

    it('plans with the index assumed on the estimate, before anything runs, and sets the estimates side by side', async () => {
      condition = '(level = 3)'
      canAssume = true
      mount()
      const section = await group()
      expect(section.textContent).toContain(p.assumeIntro)
      expect(within(diagram()).queryByText('level', { exact: true })).toBeNull()
      fireEvent.click(await assumeIt())
      expect(hypotheticalPlan).toHaveBeenCalledWith('shop', undefined, 'SELECT * FROM logs', [
        { table: 'logs', columns: ['level'], name: 'idx_logs_level' },
      ])
      await within(section).findByText(p.assumeDone('idx_logs_level'))
      expect(section.textContent).toContain(p.assumeCost(1693, 8.3))
      expect(section.textContent).toContain(
        `logs: ${p.assumeRead(null, 50000)} → ${p.assumeRead('idx_logs_level', 50)}`
      )
      expect(within(section).queryByText(p.assumeUnused('idx_logs_level'))).toBeNull()
      // The tree is the plan with it assumed, its columns the ones asked for (no structure has the index): drawn in
      // the table's box.
      expect(screen.getAllByText(/\[idx_logs_level\]/).length).toBeGreaterThan(0)
      expect(within(diagram()).getByText('level', { exact: true })).toBeTruthy()
      // Nothing was built, run or remembered.
      expect(previewDdl).not.toHaveBeenCalled()
      expect(analyzePlan).not.toHaveBeenCalled()
      expect(triedIndexes(SCOPE)).toEqual([])
      // Not offered for real until there is a run to compare with.
      expect(within(section).queryByRole('button', { name: p.assumeBuild('logs', ['level']) })).toBeNull()
      fireEvent.click(within(section).getByRole('button', { name: p.assumeBack }))
      expect(within(section).queryByText(p.assumeDone('idx_logs_level'))).toBeNull()
      expect(screen.queryAllByText(/\[idx_logs_level\]/)).toHaveLength(0)
    })

    it('asks once for two presses in a row', async () => {
      condition = '(level = 3)'
      canAssume = true
      let answer: (v: unknown) => void = () => undefined
      const held = assumedRun
      assumedRun = () => new Promise((resolve) => (answer = resolve))
      mount()
      const button = await assumeIt()
      fireEvent.click(button)
      fireEvent.click(button)
      expect(hypotheticalPlan).toHaveBeenCalledTimes(1)
      expect(button.getAttribute('aria-disabled')).toBe('true')
      answer(await held())
      await screen.findByText(p.assumeDone('idx_logs_level'))
    })

    it('says so where the server would not use the index even if it were there', async () => {
      condition = '(level = 3)'
      canAssume = true
      assumedRun = async () => ({
        plan: { ...scan, detail: condition, cost: 1693 },
        raw: '',
        rawTruncated: false,
        assumed: [],
      })
      mount()
      fireEvent.click(await assumeIt())
      expect(await screen.findByText(p.assumeUnused('idx_logs_level'))).toBeTruthy()
    })

    it('shows the server error and keeps the plan as it is', async () => {
      condition = '(level = 3)'
      canAssume = true
      assumedRun = async () => {
        throw new Error('column "level" does not exist')
      }
      mount()
      fireEvent.click(await assumeIt())
      await screen.findByText(/does not exist/)
      expect(screen.queryByText(p.assumeDone('idx_logs_level'))).toBeNull()
    })

    it('builds it for real through the trial once the statement was measured', async () => {
      condition = '(level = 3)'
      canAssume = true
      mount()
      fireEvent.click(await opener())
      fireEvent.click(screen.getByRole('button', { name: p.measureRun }))
      await screen.findByRole('region', { name: p.trialGroup })
      fireEvent.click(await assumeIt())
      const build = await screen.findByRole('button', { name: p.assumeBuild('logs', ['level']) })
      fireEvent.click(build)
      await screen.findByRole('dialog', { name: locale.ddl.titles.addIndex })
      expect(previewDdl).toHaveBeenCalledWith(
        'shop',
        undefined,
        expect.objectContaining({ op: 'addIndex', name: 'idx_logs_level' })
      )
    })

    it('says what would make it possible on a server that could, and nothing on one that cannot', async () => {
      condition = '(level = 3)'
      canAssume = false
      mount()
      const section = await group()
      expect(section.textContent).toContain(p.assumeMissing)
      expect(within(section).queryByRole('button')).toBeNull()
      cleanup()
      canAssume = undefined
      mount()
      await opener()
      expect(screen.queryByRole('region', { name: p.assumeGroup })).toBeNull()
    })
  })
})
