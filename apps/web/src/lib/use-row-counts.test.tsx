import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRowCounts } from './use-row-counts.ts'

/** The counts asked for, each answered when the test says. */
let started: { table: string; answer: (n: number) => void }[]
vi.mock('@/lib/queries.ts', () => ({
  rowCountQuery: (ref: { table: string }) => ({
    queryKey: ['count', ref.table],
    queryFn: () => new Promise<number>((answer) => started.push({ table: ref.table, answer })),
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
const estimates = new Map([['a', 10]])

describe('useRowCounts', () => {
  it('counts nothing until asked, then a few tables at a time, and puts the counts in place of the estimates', async () => {
    const { result } = renderHook(() => useRowCounts('db', undefined, tables, estimates), {
      wrapper: wrapper(new QueryClient()),
    })
    expect(started).toEqual([])
    expect(result.current.rows).toBe(estimates)
    act(() => result.current.count())
    await waitFor(() => expect(started).toHaveLength(4))
    for (let i = 0; i < tables.length; i++) {
      await waitFor(() => expect(started.length).toBeGreaterThan(i))
      await act(async () => started[i]?.answer(i))
    }
    await waitFor(() => expect(result.current.done).toBe(true))
    expect(started.map((s) => s.table)).toEqual(tables)
    expect(result.current.rows?.get('a')).toEqual({ counted: 0 })
    expect(result.current.rows?.get('f')).toEqual({ counted: 5 })
    expect(result.current.failed).toEqual([])
  })

  it('starts no more tables once closed', async () => {
    const { result, unmount } = renderHook(() => useRowCounts('db', undefined, tables, estimates), {
      wrapper: wrapper(new QueryClient()),
    })
    act(() => result.current.count())
    await waitFor(() => expect(started).toHaveLength(4))
    unmount()
    for (const s of [...started]) await act(async () => s.answer(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toHaveLength(4)
  })
})
