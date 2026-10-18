import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useAllStructures } from './use-all-structures.ts'

let running = 0
let most = 0
const read = vi.fn()
vi.mock('./queries.ts', () => ({
  structureQuery: ({ table }: { table: string }) => ({
    queryKey: ['structure', table],
    queryFn: async () => {
      read(table)
      running += 1
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 2))
      running -= 1
      if (table === 'broken') throw new Error('cannot read')
      return { name: table, columns: [] }
    },
  }),
}))

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

describe('useAllStructures', () => {
  it('reads every table a few at a time, keeping the order, and names the ones that failed', async () => {
    const names = ['a', 'b', 'broken', 'c', 'd', 'e', 'f', 'g']
    const { result } = renderHook(() => useAllStructures('shop', undefined, names), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect([...(result.current.data?.byName.keys() ?? [])]).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(result.current.data?.failed).toEqual(['broken'])
    expect(most).toBeLessThanOrEqual(4)
    expect(most).toBeGreaterThan(1)
  })

  it('reads nothing when not asked, or when there is nothing to read', () => {
    read.mockClear()
    renderHook(() => useAllStructures('shop', undefined, ['a'], { enabled: false }), { wrapper })
    renderHook(() => useAllStructures('shop', undefined, []), { wrapper })
    expect(read).not.toHaveBeenCalled()
  })

  it('reads each table once for two screens asking for the same tables, and again only the ones that failed', async () => {
    read.mockClear()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    // Two sets that overlap (two keys): each table of both is read once all the same.
    const one = renderHook(() => useAllStructures('db2', undefined, ['a', 'broken']), { wrapper: shared })
    await waitFor(() => expect(one.result.current.data).toBeDefined())
    const two = renderHook(() => useAllStructures('db2', undefined, ['broken', 'a', 'c']), { wrapper: shared })
    await waitFor(() => expect(two.result.current.data).toBeDefined())
    // broken failed for the first: an error is not kept as a definition, so the second reads it again.
    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'broken', 'broken', 'c'])
    read.mockClear()
    await one.result.current.refetch()
    expect(read.mock.calls.map((c) => c[0])).toEqual(['broken'])
  })

  it("does not show another database's definitions while this one's are read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(({ db, names }) => useAllStructures(db, undefined, names), {
      wrapper: shared,
      initialProps: { db: 'one', names: ['a'] },
    })
    await waitFor(() => expect(result.current.data).toBeDefined())
    // Another table in the same database: what was read stays shown meanwhile.
    rerender({ db: 'one', names: ['a', 'b'] })
    expect(result.current.data?.byName.has('a')).toBe(true)
    // Another database: nothing until its own are read.
    rerender({ db: 'two', names: ['x'] })
    expect(result.current.data).toBeUndefined()
  })
})
