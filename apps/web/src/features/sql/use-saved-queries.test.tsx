import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSaved } from './saved-queries.ts'
import { useSavedQueries } from './use-saved-queries.ts'

const server = vi.hoisted(() => ({ list: [] as { id: string; name: string; sql: string; at: number }[] }))
vi.mock('@/lib/queries.ts', () => ({
  savedQueriesQuery: { queryKey: ['saved-queries'], queryFn: async () => server.list },
  mutations: {
    saveQuery: async (name: string, sql: string) => {
      server.list = [...server.list.filter((q) => q.name !== name), { id: `id-${name}`, name, sql, at: 1 }]
      return server.list
    },
    deleteSavedQuery: async (id: string) => {
      server.list = server.list.filter((q) => q.id !== id)
      return server.list
    },
  },
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useSavedQueries', () => {
  beforeEach(() => {
    server.list = []
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    })
  })

  it('keeps the list in this browser when the deployment has no server-side store', async () => {
    const { result } = renderHook(() => useSavedQueries('mysql.db.3306', false), { wrapper })
    act(() => result.current.save('daily', 'SELECT 1'))
    await waitFor(() => expect(result.current.entries).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }]))
    expect(result.current.onServer).toBe(false)
    // It really went to browser storage, and not to the server.
    expect(loadSaved('mysql.db.3306')).toHaveLength(1)
    expect(server.list).toEqual([])

    act(() => result.current.remove('daily'))
    await waitFor(() => expect(result.current.entries).toEqual([]))
    expect(loadSaved('mysql.db.3306')).toEqual([])
  })

  it('keeps the list with the account when the deployment can store it', async () => {
    const { result } = renderHook(() => useSavedQueries('mysql.db.3306', true), { wrapper })
    await waitFor(() => expect(result.current.entries).toEqual([]))
    act(() => result.current.save('daily', 'SELECT 1'))
    await waitFor(() => expect(result.current.entries).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }]))
    expect(result.current.onServer).toBe(true)
    // Nothing was written to this browser: another browser signed in as the same account sees the same list.
    expect(loadSaved('mysql.db.3306')).toEqual([])
    expect(server.list).toHaveLength(1)

    // Deleting is by name in the UI but by id on the wire, because the name is not queryable server-side.
    act(() => result.current.remove('daily'))
    await waitFor(() => expect(result.current.entries).toEqual([]))
    expect(server.list).toEqual([])
  })

  it('shows a list already held for the account, without being saved to first', async () => {
    server.list = [{ id: 'id-old', name: 'from another browser', sql: 'SELECT 2', at: 1 }]
    const { result } = renderHook(() => useSavedQueries('mysql.db.3306', true), { wrapper })
    await waitFor(() => expect(result.current.entries).toMatchObject([{ name: 'from another browser' }]))
  })
})
