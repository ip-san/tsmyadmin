import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { PlanNode } from '@tsmyadmin/shared'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { ApiError } from '@/lib/api.ts'
import { memoryStorage } from '@/test/memory-storage.ts'
import { PlanView, plannedStatement } from './PlanView.tsx'

/** A statement whose values are not given: planned for any value where the server can (the rest is in PlanView.test.tsx). */

const p = locale.plan
const scan: PlanNode = {
  op: 'Seq Scan',
  table: 'logs',
  alias: null,
  index: null,
  indexColumns: [],
  access: 'fullScan',
  covering: false,
  estRows: 500,
  cost: null,
  detail: '(level = $1)',
  children: [],
}
/** The server connected to, and what it answers a plan asked for. */
let dialect: 'mysql' | 'postgres'
let answer: () => Promise<unknown>
const explained = vi.fn((..._: unknown[]) => answer())

vi.mock('@/lib/queries.ts', () => ({
  analyzePlan: async () => ({}),
  hypotheticalPlan: async () => ({}),
  explainQuery: (...args: unknown[]) => ({ queryKey: ['explain', ...args], queryFn: () => explained(...args) }),
  sessionQuery: { queryKey: ['session'], queryFn: async () => ({ dialect }) },
  isDatabaseData: (key: readonly unknown[]) => key[0] !== 'session',
  mutations: {},
  foreignKeysQuery: () => ({ queryKey: ['keys'], queryFn: async () => [] }),
  structureQuery: () => ({
    queryKey: ['structure'],
    queryFn: async () => ({ columns: [{ name: 'id' }, { name: 'level' }], indexes: [], unusableIndexes: [] }),
  }),
  tablesQuery: () => ({
    queryKey: ['tables'],
    queryFn: async () => [{ name: 'logs', kind: 'table', rowEstimate: 500 }],
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
  dialect = 'postgres'
  answer = async () => ({ plan: scan, raw: '', rawTruncated: false, canAssume: true })
  explained.mockClear()
})
afterEach(cleanup)

/** The session read first: before it is, MySQL stands in, whatever the server is. */
async function mount(sql: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await client.fetchQuery({ queryKey: ['session'], queryFn: async () => ({ dialect }) })
  render(
    <QueryClientProvider client={client}>
      <PlanView db="shop" sql={sql} scope="postgres.db.5432" onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('PlanView, a statement whose values are not given', () => {
  it('is planned for any value, as the server numbers its parameters, and says so, with nothing to run', async () => {
    await mount('SELECT * FROM logs WHERE level = :p1 AND id > :since OR level = :p1')
    expect(await screen.findByText(p.notesGeneric)).toBeTruthy()
    expect(explained).toHaveBeenCalledWith(
      'shop',
      undefined,
      'SELECT * FROM logs WHERE level = $1 AND id > $2 OR level = $1',
      true
    )
    // There are no values to run it with, nor to plan an index assumed with (once the tables are read, as above).
    await act(async () => new Promise((settle) => setTimeout(settle, 50)))
    expect(screen.queryByRole('button', { name: p.measure })).toBeNull()
    expect(screen.queryByRole('region', { name: p.assumeGroup })).toBeNull()
  })

  it('is planned as it is, with its measuring, where it has no parameters', async () => {
    await mount('SELECT * FROM logs')
    expect(await screen.findByRole('button', { name: p.measure })).toBeTruthy()
    expect(explained).toHaveBeenCalledWith('shop', undefined, 'SELECT * FROM logs', false)
    expect(screen.getByText(p.notes)).toBeTruthy()
    // The same plan, with values: an index on the condition's column can be assumed.
    expect(await screen.findByRole('region', { name: p.assumeGroup })).toBeTruthy()
  })

  it('says the values are needed on a server before PostgreSQL 16, not that it failed', async () => {
    answer = async () => {
      throw new ApiError(400, { code: 'UNSUPPORTED', message: 'A plan without values needs PostgreSQL 16 or later' })
    }
    await mount('SELECT * FROM logs WHERE level = :p1')
    expect(await screen.findByText(p.genericUnsupported)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks for the values first on a server that plans only with them, asking it nothing', async () => {
    dialect = 'mysql'
    await mount('SELECT * FROM logs WHERE level = :p1')
    expect(await screen.findByText(p.valuesNeeded)).toBeTruthy()
    expect(explained).not.toHaveBeenCalled()
  })

  it('says what mends it where the server cannot plan it for any value', async () => {
    answer = async () => {
      throw new ApiError(400, { code: 'QUERY_FAILED', message: 'could not determine data type of parameter $1' })
    }
    await mount('SELECT :p1')
    expect(await screen.findByText(p.genericFailed)).toBeTruthy()
  })
})

describe('plannedStatement', () => {
  it("numbers the server's own $1 written in the editor with the names, so they do not collide", () => {
    expect(plannedStatement('SELECT * FROM t WHERE a = $1 AND b = :x', 'postgres')).toEqual({
      sql: 'SELECT * FROM t WHERE a = $1 AND b = $2',
      generic: true,
      missing: false,
    })
    expect(plannedStatement('SELECT * FROM t WHERE a = $1', 'postgres').generic).toBe(true)
  })

  it('leaves a statement with no parameters, or on MySQL, as it is', () => {
    expect(plannedStatement("SELECT '$1', a::int FROM t", 'postgres')).toEqual({
      sql: "SELECT '$1', a::int FROM t",
      generic: false,
      missing: false,
    })
    expect(plannedStatement('SELECT * FROM t WHERE a = :x', 'mysql')).toEqual({
      sql: 'SELECT * FROM t WHERE a = :x',
      generic: false,
      missing: true,
    })
  })
})
