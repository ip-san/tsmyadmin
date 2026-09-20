import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { shareWorkspaceEntry } from './account-prefs.ts'
import { type PreferenceStore, readPreference, writePreference } from './preferences.ts'
import { sessionQuery } from './queries.ts'

/**
 * phpMyAdmin's "Recent" and "Favorites" tables: per browser, and per connection (the same name means another
 * table on another server or account).
 */
export interface TableShortcut {
  db: string
  schema?: string | undefined
  table: string
}

const ListSchema = z.array(z.object({ db: z.string(), schema: z.string().optional(), table: z.string() })).max(100)

export const RECENT_LIMIT = 10
const FAVORITE_LIMIT = 50

const same = (a: TableShortcut, b: TableShortcut) =>
  a.db === b.db && (a.schema ?? '') === (b.schema ?? '') && a.table === b.table

/** The table first, then the others without it, cut to the limit. */
export function pushRecent(list: TableShortcut[], ref: TableShortcut, limit = RECENT_LIMIT): TableShortcut[] {
  return [ref, ...list.filter((x) => !same(x, ref))].slice(0, limit)
}

/** The list with the table added (at the end) or, if it was there, taken out. */
export function toggleIn(list: TableShortcut[], ref: TableShortcut, limit = FAVORITE_LIMIT): TableShortcut[] {
  return list.some((x) => same(x, ref)) ? list.filter((x) => !same(x, ref)) : [...list, ref].slice(-limit)
}

const clean = (ref: TableShortcut): TableShortcut => ({
  db: ref.db,
  ...(ref.schema ? { schema: ref.schema } : {}),
  table: ref.table,
})

// Components showing the lists re-read them when either changes (the table page and the sidebar are apart).
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reads and changes the shortcut lists of one connection. */
export function shortcutStore(server: string, store?: PreferenceStore | null) {
  const key = (kind: 'recent' | 'favorites') => `tables.${kind}.${server}`
  const read = (kind: 'recent' | 'favorites') => readPreference(key(kind), ListSchema, [], store) as TableShortcut[]
  const write = (kind: 'recent' | 'favorites', list: TableShortcut[]) => {
    // Revisiting the table already at the top changes nothing: no write, and no re-render for the listeners.
    if (JSON.stringify(read(kind)) === JSON.stringify(list)) return
    writePreference(key(kind), list, store)
    shareWorkspaceEntry(key(kind), list)
    changed()
  }
  return {
    read,
    visit: (ref: TableShortcut) => write('recent', pushRecent(read('recent'), clean(ref))),
    toggleFavorite: (ref: TableShortcut) => write('favorites', toggleIn(read('favorites'), clean(ref))),
  }
}

/** The connection the lists belong to; empty before the session is known. */
function useServerKey(): string {
  const s = useQuery(sessionQuery).data
  return s ? `${s.dialect}|${s.host}|${s.port}|${s.user}` : ''
}

export function useTableShortcuts() {
  const server = useServerKey()
  const store = useMemo(() => shortcutStore(server), [server])
  // Stable snapshots: the stored JSON only changes when written, so it compares as a string.
  const recentRaw = useSyncExternalStore(subscribe, () => JSON.stringify(server ? store.read('recent') : []))
  const favoritesRaw = useSyncExternalStore(subscribe, () => JSON.stringify(server ? store.read('favorites') : []))
  const favorites = JSON.parse(favoritesRaw) as TableShortcut[]
  const isFavorite = useCallback((ref: TableShortcut) => favorites.some((x) => same(x, ref)), [favorites])
  // Stable per connection, so a page can record its visit in an effect without re-running it every render.
  const visit = useCallback((ref: TableShortcut) => server && store.visit(ref), [server, store])
  const toggleFavorite = useCallback((ref: TableShortcut) => server && store.toggleFavorite(ref), [server, store])
  return { recent: JSON.parse(recentRaw) as TableShortcut[], favorites, isFavorite, visit, toggleFavorite }
}
