import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { PlanView } from './PlanView.tsx'

const t = locale.planTour

/** The tables' estimated rows the list answers with; an error where it cannot be read. */
let estimated: Record<string, number> | Error
/** Holds the list back until it is let go. */
let listed: Promise<void>
/** What a measured run answers, and the runs asked for. */
let measuredRun: () => Promise<unknown>
const analyzePlan = vi.fn((..._: unknown[]) => measuredRun())

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
  explainQuery: () => ({ queryKey: ['explain'], queryFn: async () => ({ plan: scan, raw: '', rawTruncated: false }) }),
  foreignKeysQuery: () => ({ queryKey: ['keys'], queryFn: async () => [] }),
  structureQuery: () => ({ queryKey: ['structure'], queryFn: async () => ({ indexes: [] }) }),
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
})
beforeEach(() => {
  estimated = { logs: 10000 }
  listed = Promise.resolve()
  analyzePlan.mockClear()
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
    const p = locale.plan
    const opener = async () => screen.findByRole('button', { name: p.measure })

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
  })
})
