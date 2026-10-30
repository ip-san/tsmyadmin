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
    expect(screen.getByRole('status', { name: '' }).textContent).toBe(t.waiting)
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
})
