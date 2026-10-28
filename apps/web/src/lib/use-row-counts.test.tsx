import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRowCounts } from './use-row-counts.ts'

/** The counts asked for, each answered when the test says. */
let started: { table: string; answer: (n: number) => void; fail: () => void }[]
vi.mock('@/lib/queries.ts', () => ({
  rowCountQuery: (ref: { table: string }) => ({
    queryKey: ['count', ref.table],
    queryFn: () =>
      new Promise<number>((answer, reject) =>
        started.push({ table: ref.table, answer, fail: () => reject(new Error('timeout')) })
      ),
    retry: false,
  }),
}))

beforeEach(() => {
  started = []
})

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

const tables = ['a', 'b', 'c', 'd', 'e', 'f']
// As the app has it: a query read a moment ago is not read again.
const client = () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } })

/** Answers the counts in turn, from the `from`th asked for: `fail` for the tables that fail. */
async function answerAll(from: number, fail: readonly string[] = []) {
  for (let i = from; i < from + tables.length; i++) {
    await waitFor(() => expect(started.length).toBeGreaterThan(i))
    const s = started[i]
    await act(async () => (s && fail.includes(s.table) ? s.fail() : s?.answer(i - from)))
  }
}
const estimates = new Map([['a', 10]])

describe('useRowCounts', () => {
  it('counts nothing until asked, then a few tables at a time, and puts the counts in place of the estimates', async () => {
    const { result } = renderHook(() => useRowCounts('db', undefined, tables, estimates), {
      wrapper: wrapper(client()),
    })
    expect(started).toEqual([])
    expect(result.current.rows).toBe(estimates)
    act(() => {
      result.current.count()
      // A second press while counting joins the count running: no table is counted twice.
      result.current.count()
    })
    await waitFor(() => expect(started).toHaveLength(4))
    await answerAll(0)
    await waitFor(() => expect(result.current.done).toBe(true))
    expect(started.map((s) => s.table)).toEqual(tables)
    expect(result.current.rows?.get('a')).toEqual({ counted: 0 })
    expect(result.current.rows?.get('f')).toEqual({ counted: 5 })
    expect(result.current.failed).toEqual([])
  })

  it('starts no more tables once closed', async () => {
    const { result, unmount } = renderHook(() => useRowCounts('db', undefined, tables, estimates), {
      wrapper: wrapper(client()),
    })
    act(() => result.current.count())
    await waitFor(() => expect(started).toHaveLength(4))
    unmount()
    for (const s of [...started]) await act(async () => s.answer(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toHaveLength(4)
  })

  it('counts again when pressed again, though the last count is a moment old', async () => {
    const { result } = renderHook(() => useRowCounts('db', undefined, tables, estimates), {
      wrapper: wrapper(client()),
    })
    act(() => result.current.count())
    await answerAll(0)
    await waitFor(() => expect(result.current.done).toBe(true))
    act(() => result.current.count())
    await answerAll(tables.length)
    await waitFor(() => expect(result.current.rows?.get('f')).toEqual({ counted: 5 }))
    expect(started).toHaveLength(2 * tables.length)
  })

  it('keeps the estimate of a table that fails, and names it', async () => {
    const { result } = renderHook(() => useRowCounts('db', undefined, tables, estimates), {
      wrapper: wrapper(client()),
    })
    act(() => result.current.count())
    await answerAll(0, ['a'])
    await waitFor(() => expect(result.current.done).toBe(true))
    expect(result.current.failed).toEqual(['a'])
    expect(result.current.rows?.get('a')).toBe(10)
  })

  it('tells the estimates again when opened again, until counted again', async () => {
    const shared = client()
    const first = renderHook(() => useRowCounts('db', undefined, tables, estimates), { wrapper: wrapper(shared) })
    act(() => first.result.current.count())
    await answerAll(0)
    await waitFor(() => expect(first.result.current.done).toBe(true))
    first.unmount()
    await new Promise((r) => setTimeout(r, 10))
    const again = renderHook(() => useRowCounts('db', undefined, tables, estimates), { wrapper: wrapper(shared) })
    expect(again.result.current.done).toBe(false)
    expect(again.result.current.rows).toBe(estimates)
  })
})
