import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { QueryBuilderRequestInput, QueryBuilderResult, TableSchema } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale as base } from '@/config/locale.ts'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, table } from '@/test/schema-fixtures.ts'
import { QueryTour } from './QueryTour.tsx'

const t = locale.queryTour

/** What the mocked API answers for the plan, and the choices it was asked for; set afresh for each test. */
let plan: QueryBuilderResult | Error
let asked: QueryBuilderRequestInput[]
/** The list of tables, with their estimated rows, or why it could not be read. */
let list: { name: string; rowEstimate: number | null }[] | Error

vi.mock('@/lib/session.ts', () => ({ useDialect: () => 'mysql' }))
vi.mock('@/lib/queries.ts', () => ({
  queryPlanQuery: (_db: string, body: QueryBuilderRequestInput) => ({
    queryKey: ['query-plan', JSON.stringify(body)],
    queryFn: async () => {
      asked.push(body)
      if (plan instanceof Error) throw plan
      return plan
    },
    retry: false,
  }),
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => {
      if (list instanceof Error) throw list
      return list
    },
    retry: false,
  }),
}))

const schemas = new Map<string, TableSchema>([
  [
    'orders',
    table('orders', {
      columns: [column('id', 'int'), column('user_id', 'int')],
      foreignKeys: [fk(['user_id'], 'users')],
    }),
  ],
  ['users', table('users', { columns: [column('id', 'int')] })],
])
const request: QueryBuilderRequestInput = { tables: ['orders', 'users'] }

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

beforeEach(() => {
  asked = []
  list = [
    { name: 'orders', rowEstimate: 500 },
    { name: 'users', rowEstimate: 100 },
  ]
  plan = {
    sql: 'SELECT * FROM orders LEFT JOIN users ON users.id = orders.user_id',
    joins: [
      {
        table: 'users',
        kind: 'left',
        on: [{ a: { table: 'users', column: 'id' }, b: { table: 'orders', column: 'user_id' } }],
        key: { table: 'orders', name: 'fk_users' },
      },
    ],
  }
})
afterEach(cleanup)

const show = (over: Partial<Parameters<typeof QueryTour>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QueryTour db="shop" schema={undefined} request={request} schemas={schemas} disabled={false} {...over} />
    </QueryClientProvider>
  )

describe('QueryTour', () => {
  it('opens on the choices as they are, asks the server how it joins them, and tells it', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: t.open }))
    const dialog = await screen.findByRole('dialog', { name: t.dialog })
    expect(dialog).toBeTruthy()
    expect(asked).toEqual([request])
    expect(await screen.findByRole('heading', { level: 3, name: t.introTitle })).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'End' })
    expect(await screen.findByRole('heading', { level: 3, name: t.endTitle })).toBeTruthy()
  })

  it('cannot be opened with no table chosen', () => {
    show({ disabled: true })
    expect(screen.getByRole('button', { name: t.open })).toHaveProperty('disabled', true)
  })

  it('says why when the plan cannot be read, and reads it again', async () => {
    plan = new Error('No foreign key connects users to orders')
    show()
    fireEvent.click(screen.getByRole('button', { name: t.open }))
    expect(await screen.findByText(/No foreign key connects/)).toBeTruthy()
    plan = { sql: 'SELECT * FROM orders', joins: [] }
    fireEvent.click(screen.getByRole('button', { name: base.common.retry }))
    await waitFor(() => expect(asked).toHaveLength(2))
    expect(await screen.findByRole('heading', { level: 3, name: t.introTitle })).toBeTruthy()
  })

  it("says the rows by the catalog's estimates, and goes on without them where the list cannot be read", async () => {
    const w = locale.designReading
    show()
    fireEvent.click(screen.getByRole('button', { name: t.open }))
    const dialog = await screen.findByRole('dialog', { name: t.dialog })
    await screen.findByRole('heading', { level: 3, name: t.introTitle })
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(await screen.findByText(w.rows('orders', 500))).toBeTruthy()
    cleanup()
    list = new Error('denied')
    show()
    fireEvent.click(screen.getByRole('button', { name: t.open }))
    const again = await screen.findByRole('dialog', { name: t.dialog })
    await screen.findByRole('heading', { level: 3, name: t.introTitle })
    fireEvent.keyDown(again, { key: 'ArrowRight' })
    expect(await screen.findByRole('heading', { level: 3, name: t.fromTitle('orders') })).toBeTruthy()
    expect(screen.queryByText(w.rows('orders', 500))).toBeNull()
  })
})
