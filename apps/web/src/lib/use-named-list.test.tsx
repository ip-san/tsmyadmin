import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useNamedList } from './use-named-list.ts'

interface Item {
  id: string
  name: string
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useNamedList', () => {
  it('deletes the row it was given, not the first of that name', async () => {
    // What the export templates look like on the server: one name, two databases, one account.
    const listed: Item[] = [
      { id: 'shop-nightly', name: 'nightly' },
      { id: 'blog-nightly', name: 'nightly' },
    ]
    const removeOnServer = vi.fn(async (id: string) => listed.filter((item) => item.id !== id))
    const { result } = renderHook(
      () =>
        useNamedList<Item, string>({
          onServer: true,
          query: { queryKey: ['items'], queryFn: async () => listed },
          saveOnServer: async () => listed,
          removeOnServer,
          local: { load: () => [], save: () => [], remove: () => [] },
        }),
      { wrapper }
    )
    await waitFor(() => expect(result.current.entries).toHaveLength(2))

    act(() => result.current.remove({ id: 'blog-nightly', name: 'nightly' }))
    // The id of the row handed in, not of the first row that happens to carry the name.
    await waitFor(() => expect(removeOnServer.mock.calls[0]?.[0]).toBe('blog-nightly'))
    await waitFor(() => expect(result.current.entries).toEqual([{ id: 'shop-nightly', name: 'nightly' }]))
  })
})
