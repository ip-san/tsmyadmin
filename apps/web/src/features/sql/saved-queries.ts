import { z } from 'zod'
import { type PreferenceStore, readPreference, writePreference } from '@/lib/preferences.ts'

const SavedQuerySchema = z.object({ name: z.string().min(1), sql: z.string().min(1), at: z.number() })
export type SavedQuery = z.infer<typeof SavedQuerySchema>
const ListSchema = z.array(SavedQuerySchema)
const SAVED_LIMIT = 200
/** `scope` identifies the server (dialect:host:port): two MySQL servers must not share one list. */
const key = (scope: string) => `sql.saved.${scope}`

/** Bookmarked statements (phpMyAdmin "bookmarks"), per dialect, in this browser. */
export function loadSaved(scope: string, store?: PreferenceStore): SavedQuery[] {
  return readPreference(key(scope), ListSchema, [], store)
}

/** Adds or replaces (by name) a saved query and returns the new list, newest first. */
export function saveQuery(scope: string, entry: SavedQuery, store?: PreferenceStore): SavedQuery[] {
  const next = [entry, ...loadSaved(scope, store).filter((q) => q.name !== entry.name)].slice(0, SAVED_LIMIT)
  writePreference(key(scope), next, store)
  return next
}

export function deleteSaved(scope: string, name: string, store?: PreferenceStore): SavedQuery[] {
  const next = loadSaved(scope, store).filter((q) => q.name !== name)
  writePreference(key(scope), next, store)
  return next
}
