import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRowEstimates } from './use-row-estimates.ts'

/** What the list of tables answers, in turn. */
let answers: ({ name: string; rowEstimate: number | null }[] | Error)[]
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: (db: string) => ({
    queryKey: ['tables', db],
    queryFn: async () => {
      const next = answers.shift()
      if (next === undefined || next instanceof Error) throw next ?? new Error('none')
      return next
    },
    retry: false,
  }),
}))

beforeEach(() => {
  answers = []
})

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('useRowEstimates', () => {
  it('waits for the list, then keeps the estimates it read though the list is read again', async () => {
    answers = [[{ name: 'orders', rowEstimate: 500 }], [{ name: 'orders', rowEstimate: 900 }]]
    const client = new QueryClient()
    const { result } = renderHook(() => useRowEstimates('db', undefined), { wrapper: wrapper(client) })
    expect(result.current.pending).toBe(true)
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect([...(result.current.rows ?? [])]).toEqual([['orders', 500]])
    await client.refetchQueries()
    await waitFor(() => expect(client.getQueryData(['tables', 'db'])).toEqual([{ name: 'orders', rowEstimate: 900 }]))
    expect([...(result.current.rows ?? [])]).toEqual([['orders', 500]])
  })

  it('goes on without estimates where the list cannot be read', async () => {
    answers = [new Error('denied')]
    const { result } = renderHook(() => useRowEstimates('db', undefined), { wrapper: wrapper(new QueryClient()) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.rows).toBeUndefined()
  })

  it("reads anew for another database, rather than keeping the first one's", async () => {
    answers = [[{ name: 'orders', rowEstimate: 500 }], [{ name: 'orders', rowEstimate: 900 }]]
    const { result, rerender } = renderHook(({ db }) => useRowEstimates(db, undefined), {
      wrapper: wrapper(new QueryClient()),
      initialProps: { db: 'a' },
    })
    await waitFor(() => expect(result.current.rows?.get('orders')).toBe(500))
    rerender({ db: 'b' })
    await waitFor(() => expect(result.current.rows?.get('orders')).toBe(900))
  })
})
