import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSaved } from './saved-queries.ts'
import { useSavedQueries } from './use-saved-queries.ts'

const server = vi.hoisted(() => ({
  list: [] as { id: string; name: string; sql: string; at: number }[],
  saveFail: null as Error | null,
  deleteFail: null as Error | null,
  /** Held until the test releases it, to make a save settle after a delete submitted later. */
  saveHold: null as Promise<void> | null,
}))
vi.mock('@/lib/queries.ts', () => ({
  savedQueriesQuery: { queryKey: ['saved-queries'], queryFn: async () => server.list },
  mutations: {
    saveQuery: async (name: string, sql: string) => {
      if (server.saveHold) await server.saveHold
      if (server.saveFail) throw server.saveFail
      server.list = [...server.list.filter((q) => q.name !== name), { id: `id-${name}`, name, sql, at: 1 }]
      return server.list
    },
    deleteSavedQuery: async (id: string) => {
      if (server.deleteFail) throw server.deleteFail
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
    server.saveFail = null
    server.deleteFail = null
    server.saveHold = null
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
  it('stops reporting a failed save once a later write has succeeded', async () => {
    server.list = [{ id: 'id-old', name: 'old', sql: 'SELECT 2', at: 1 }]
    const { result } = renderHook(() => useSavedQueries('mysql.db.3306', true), { wrapper })
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    server.saveFail = new Error('the deployment refused it')
    act(() => result.current.save('daily', 'SELECT 1'))
    await waitFor(() => expect(result.current.error).not.toBeNull())

    // A mutation keeps its error until it is fired again, so the failed save must not outlive a later success.
    server.saveFail = null
    act(() => result.current.remove('old'))
    await waitFor(() => expect(result.current.entries).toEqual([]))
    expect(result.current.error).toBeNull()
  })

  it('reports a save that fails after a later delete has already succeeded', async () => {
    server.list = [{ id: 'id-old', name: 'old', sql: 'SELECT 2', at: 1 }]
    const { result } = renderHook(() => useSavedQueries('mysql.db.3306', true), { wrapper })
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    // Submitted first, settles last: which write was submitted first is the wrong thing to go by.
    let release: () => void = () => undefined
    server.saveHold = new Promise<void>((resolve) => {
      release = resolve
    })
    server.saveFail = new Error('the deployment refused it')
    act(() => result.current.save('daily', 'SELECT 1'))

    act(() => result.current.remove('old'))
    await waitFor(() => expect(result.current.entries).toEqual([]))
    expect(result.current.error).toBeNull()

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.error?.message).toBe('the deployment refused it'))
  })

  it('reports a failed write instead of doing nothing on screen', async () => {
    server.saveFail = new Error('the deployment refused it')
    const { result } = renderHook(() => useSavedQueries('mysql.db.3306', true), { wrapper })
    await waitFor(() => expect(result.current.entries).toEqual([]))
    act(() => result.current.save('daily', 'SELECT 1'))
    // A 401 is handled globally; anything else has to reach the panel, or the save looks like a no-op.
    await waitFor(() => expect(result.current.error?.message).toBe('the deployment refused it'))
  })
})
