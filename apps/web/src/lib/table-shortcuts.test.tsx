import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreferenceStore } from './preferences.ts'
import {
  pushRecent,
  RECENT_LIMIT,
  shortcutStore,
  type TableShortcut,
  toggleIn,
  useTableShortcuts,
} from './table-shortcuts.ts'

const session = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }))
const shared = vi.hoisted(() => vi.fn())
vi.mock('./queries.ts', () => ({
  sessionQuery: { queryKey: ['session'], queryFn: async () => session.value },
}))
vi.mock('./account-prefs.ts', () => ({ shareWorkspaceEntry: shared }))

const memory = () => {
  const data = new Map<string, string>()
  const store: PreferenceStore & { sets: number } = {
    sets: 0,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      store.sets++
      data.set(k, v)
    },
    removeItem: (k) => void data.delete(k),
  }
  return store
}
const t = (table: string, db = 'shop', schema?: string) => ({ db, ...(schema ? { schema } : {}), table })

describe('pushRecent / toggleIn', () => {
  it('keeps the most recent first, once each, up to the limit', () => {
    let list: TableShortcut[] = [t('a'), t('b')]
    list = pushRecent(list, t('b'))
    expect(list.map((x) => x.table)).toEqual(['b', 'a'])
    for (let i = 0; i < RECENT_LIMIT + 5; i++) list = pushRecent(list, t(`t${i}`))
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0]?.table).toBe(`t${RECENT_LIMIT + 4}`)
  })
  it('tells a table from the one of the same name in another database or schema', () => {
    expect(pushRecent([t('users', 'a')], t('users', 'b'))).toEqual([t('users', 'b'), t('users', 'a')])
    expect(toggleIn([t('users', 'a')], t('users', 'b'))).toEqual([t('users', 'a'), t('users', 'b')])
    const list = pushRecent([t('users', 'shop', 'app')], t('users', 'shop', 'audit'))
    expect(list).toHaveLength(2)
    expect(toggleIn(list, t('users', 'shop', 'app'))).toEqual([t('users', 'shop', 'audit')])
  })
  it('treats no schema and an empty schema as the same table', () => {
    expect(pushRecent([{ db: 'd', schema: '', table: 'x' }], t('x', 'd'))).toEqual([t('x', 'd')])
  })
  it('adds a favorite at the end, takes it out again, and keeps only the last ones up to the limit', () => {
    expect(toggleIn([], t('a'))).toEqual([t('a')])
    expect(toggleIn([t('a'), t('b')], t('a'))).toEqual([t('b')])
    expect(toggleIn([t('a'), t('b')], t('c'))).toEqual([t('a'), t('b'), t('c')])
    expect(toggleIn([t('a'), t('b')], t('c'), 2)).toEqual([t('b'), t('c')])
  })
  it('cuts recent to the limit, keeping the newest', () => {
    expect(pushRecent([t('a'), t('b')], t('c'), 2)).toEqual([t('c'), t('a')])
  })
})

describe('shortcutStore', () => {
  beforeEach(() => shared.mockClear())

  it('keeps recent and favorites as separate lists under their own keys', () => {
    const store = memory()
    const s = shortcutStore('srv', store)
    s.visit(t('a'))
    s.visit(t('b'))
    s.toggleFavorite(t('f'))
    expect(s.read('recent')).toEqual([t('b'), t('a')])
    expect(s.read('favorites')).toEqual([t('f')])
    expect(store.getItem('tsmyadmin.pref.tables.recent.srv')).toBe(JSON.stringify([t('b'), t('a')]))
    expect(store.getItem('tsmyadmin.pref.tables.favorites.srv')).toBe(JSON.stringify([t('f')]))
  })

  it('keeps each connection’s lists apart', () => {
    const store = memory()
    const one = shortcutStore('mysql|db|3306|root', store)
    const other = shortcutStore('mysql|db|3306|alice', store)
    one.visit(t('orders'))
    one.toggleFavorite(t('users'))
    expect(one.read('recent')).toEqual([t('orders')])
    expect(one.read('favorites')).toEqual([t('users')])
    expect(other.read('recent')).toEqual([])
    expect(other.read('favorites')).toEqual([])
  })

  it('stores a table without an empty schema', () => {
    const s = shortcutStore('srv', memory())
    s.visit({ db: 'd', schema: '', table: 'x' })
    s.visit({ db: 'd', schema: 'public', table: 'y' })
    expect(s.read('recent')).toEqual([t('y', 'd', 'public'), t('x', 'd')])
  })

  it('shares each change with the account under the same key', () => {
    const s = shortcutStore('srv', memory())
    s.visit(t('a'))
    expect(shared).toHaveBeenCalledWith('tables.recent.srv', [t('a')])
    s.toggleFavorite(t('a'))
    expect(shared).toHaveBeenLastCalledWith('tables.favorites.srv', [t('a')])
  })

  it('writes and shares nothing when the list would not change', () => {
    const store = memory()
    const s = shortcutStore('srv', store)
    s.visit(t('a'))
    s.visit(t('b'))
    const sets = store.sets
    shared.mockClear()
    s.visit(t('b'))
    expect(store.sets).toBe(sets)
    expect(shared).not.toHaveBeenCalled()
  })
})

describe('useTableShortcuts', () => {
  const RECENT_KEY = 'tsmyadmin.pref.tables.recent.mysql|db|3306|root'
  let data: Map<string, string>
  let client: QueryClient
  beforeEach(() => {
    data = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    })
    session.value = { dialect: 'mysql', host: 'db', port: 3306, user: 'root' }
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const sessionKnown = () => waitFor(() => expect(client.getQueryState(['session'])?.status).toBe('success'))

  it('does nothing while there is no session', async () => {
    session.value = null
    const { result } = renderHook(() => useTableShortcuts(), { wrapper })
    await sessionKnown()
    act(() => result.current.visit(t('a')))
    act(() => result.current.toggleFavorite(t('a')))
    expect(data.size).toBe(0)
    expect(result.current.recent).toEqual([])
    expect(result.current.favorites).toEqual([])
  })

  it('records visits and favorites for the connection, and tells every user of the lists', async () => {
    // A list stored before the session is known shows once it is: that is when the hook has its connection.
    data.set(RECENT_KEY, JSON.stringify([t('seed')]))
    const a = renderHook(() => useTableShortcuts(), { wrapper })
    const b = renderHook(() => useTableShortcuts(), { wrapper })
    await waitFor(() => expect(a.result.current.recent).toEqual([t('seed')]))
    await waitFor(() => expect(b.result.current.recent).toEqual([t('seed')]))
    act(() => a.result.current.visit(t('orders')))
    expect(a.result.current.recent).toEqual([t('orders'), t('seed')])
    // The other component re-reads without being asked.
    expect(b.result.current.recent).toEqual([t('orders'), t('seed')])
    act(() => a.result.current.toggleFavorite(t('users')))
    expect(b.result.current.favorites).toEqual([t('users')])
    expect(b.result.current.isFavorite(t('users'))).toBe(true)
    expect(b.result.current.isFavorite(t('orders'))).toBe(false)
    expect(data.get(RECENT_KEY)).toBe(JSON.stringify([t('orders'), t('seed')]))
    expect(data.has('tsmyadmin.pref.tables.favorites.mysql|db|3306|root')).toBe(true)
  })
})
