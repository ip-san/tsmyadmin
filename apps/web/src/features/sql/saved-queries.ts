import type { Dialect } from '@tsmyadmin/shared'
import { z } from 'zod'
import { type PreferenceStore, readPreference, writePreference } from '@/lib/preferences.ts'

const SavedQuerySchema = z.object({ name: z.string().min(1), sql: z.string().min(1), at: z.number() })
export type SavedQuery = z.infer<typeof SavedQuerySchema>
const ListSchema = z.array(SavedQuerySchema)
const SAVED_LIMIT = 200
const key = (dialect: Dialect) => `sql.saved.${dialect}`

/** Bookmarked statements (phpMyAdmin "bookmarks"), per dialect, in this browser. */
export function loadSaved(dialect: Dialect, store?: PreferenceStore): SavedQuery[] {
  return readPreference(key(dialect), ListSchema, [], store)
}

/** Adds or replaces (by name) a saved query and returns the new list, newest first. */
export function saveQuery(dialect: Dialect, entry: SavedQuery, store?: PreferenceStore): SavedQuery[] {
  const next = [entry, ...loadSaved(dialect, store).filter((q) => q.name !== entry.name)].slice(0, SAVED_LIMIT)
  writePreference(key(dialect), next, store)
  return next
}

export function deleteSaved(dialect: Dialect, name: string, store?: PreferenceStore): SavedQuery[] {
  const next = loadSaved(dialect, store).filter((q) => q.name !== name)
  writePreference(key(dialect), next, store)
  return next
}
