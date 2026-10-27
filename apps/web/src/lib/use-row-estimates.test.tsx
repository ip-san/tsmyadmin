import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRowEstimates } from './use-row-estimates.ts'

/** What the list of tables answers, in turn. */
let answers: ({ name: string; rowEstimate: number | null }[] | Error)[]
vi.mock('@/lib/queries.ts', () => ({
  tablesQuery: () => ({
    queryKey: ['tables'],
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
    await waitFor(() => expect(client.getQueryData(['tables'])).toEqual([{ name: 'orders', rowEstimate: 900 }]))
    expect([...(result.current.rows ?? [])]).toEqual([['orders', 500]])
  })

  it('goes on without estimates where the list cannot be read', async () => {
    answers = [new Error('denied')]
    const { result } = renderHook(() => useRowEstimates('db', undefined), { wrapper: wrapper(new QueryClient()) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.rows).toBeUndefined()
  })
})
