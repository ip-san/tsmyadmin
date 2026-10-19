import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { BrowseResult } from '@tsmyadmin/shared'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, table } from '@/test/schema-fixtures.ts'
import { RowTour } from './RowTour.tsx'
import { type RowNode, rowNode } from './row-graph.ts'

const t = locale.rowTour

type Page = RowNode['page'] & Pick<BrowseResult, 'rows' | 'total' | 'count'>
const page = (names: string[], rows: unknown[][], over: Partial<Page> = {}): Page => ({
  columns: names.map((name) => ({ name, dataType: 'int' })),
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [],
  referencedBy: [],
  rows: rows as Page['rows'],
  total: rows.length,
  count: 'exact',
  ...over,
})
const orders = page(['id', 'user_id'], [[1, 7]], { foreignKeys: [fk(['user_id'], 'users')] })
const root = rowNode({ db: 'shop', schema: undefined, table: 'orders' }, orders, [1, 7])

/** What was read, in order; and whether a read is to fail. */
let reads: string[]
let fail: boolean
vi.mock('@/lib/queries.ts', () => ({
  rowsQuery: (ref: { table: string }, options: unknown) => ({
    queryKey: ['rows', ref.table, options],
    queryFn: async () => {
      reads.push(`rows ${ref.table}`)
      if (fail) throw new Error('cannot read')
      return ref.table === 'users' ? page(['id', 'email'], [[7, 'alice@example.com']]) : page(['id'], [])
    },
  }),
  structureQuery: (ref: { table: string }) => ({
    queryKey: ['structure', ref.table],
    queryFn: async () => {
      reads.push(`structure ${ref.table}`)
      return table(ref.table, {
        comment: ref.table === 'users' ? '会員' : null,
        columns: [column('id', 'int'), column('user_id', 'int', { nullable: false })],
      })
    },
  }),
}))

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

beforeEach(() => {
  reads = []
  fail = false
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }))
})

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RowTour root={root} onClose={() => undefined} />
    </QueryClientProvider>
  )

describe('RowTour', () => {
  it('reads the rows around the row, then the definitions, and tells the row from its start', async () => {
    mount()
    expect(await screen.findByRole('img', { name: t.diagram('orders') })).toBeInTheDocument()
    expect(reads).toEqual(['rows users', 'structure orders', 'structure users'])
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('orders id=1')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(t.refersTitle('users'))
    expect(screen.getByRole('region', { name: locale.tour.notes })).toHaveTextContent(locale.designReading.named('users', '会員'))
    expect(screen.getByRole('region', { name: locale.tour.hints })).toBeInTheDocument()
  })

  it('says why the rows cannot be read, and reads them again', async () => {
    fail = true
    mount()
    expect(await screen.findByText('cannot read')).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: locale.common.retry }))
    expect(await screen.findByRole('img', { name: t.diagram('orders') })).toBeInTheDocument()
  })
})
