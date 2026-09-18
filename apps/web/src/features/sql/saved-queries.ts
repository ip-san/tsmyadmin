import type { SavedQuery } from '@tsmyadmin/shared'
import { SavedQuerySchema } from '@tsmyadmin/shared'
import { loadNamed, removeNamed, saveNamed } from '@/lib/named-storage.ts'
import type { PreferenceStore } from '@/lib/preferences.ts'

/** `scope` identifies the server (dialect:host:port): two MySQL servers must not share one list. */
const key = (scope: string) => `sql.saved.${scope}`

/**
 * Bookmarked statements (phpMyAdmin "bookmarks"), per server, in this browser. Used only where the deployment
 * has no persistent session store to keep them in; otherwise they live with the account (see `savedQueries`).
 */
export function loadSaved(scope: string, store?: PreferenceStore): SavedQuery[] {
  return loadNamed(key(scope), SavedQuerySchema, store)
}

/** Adds or replaces (by name) a saved query and returns the new list, newest first. */
export function saveQuery(scope: string, entry: SavedQuery, store?: PreferenceStore): SavedQuery[] {
  return saveNamed(key(scope), SavedQuerySchema, entry, store)
}

export function deleteSaved(scope: string, name: string, store?: PreferenceStore): SavedQuery[] {
  return removeNamed(key(scope), SavedQuerySchema, name, store)
}
