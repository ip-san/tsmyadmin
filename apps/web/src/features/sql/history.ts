import { type HistoryEntry, HistoryEntrySchema, SQL_HISTORY_MAX_SQL } from '@tsmyadmin/shared'
import { z } from 'zod'
import { type PreferenceStore, readPreference, removePreference, writePreference } from '@/lib/preferences.ts'
import { historyLimit } from '@/lib/settings.ts'

export type { HistoryEntry }

const ListSchema = z.array(HistoryEntrySchema)

/** `scope` identifies the server (dialect:host:port): two MySQL servers must not share one list. */
const key = (scope: string) => `sql.history.${scope}`

/** Recent statements per dialect, in this browser (same storage convention as saved queries). */
export function loadHistory(scope: string, store?: PreferenceStore): HistoryEntry[] {
  return readPreference(key(scope), ListSchema, [], store)
}

/** The list with `entry` first (identical SQL de-duplicated), cut to the limit in the settings. */
export function withEntry(list: HistoryEntry[], entry: HistoryEntry, limit = historyLimit()): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.sql !== entry.sql)].slice(0, limit)
}

/** Prepends an entry and stores the list in this browser. Returns the new list. */
export function pushHistory(scope: string, entry: HistoryEntry, store?: PreferenceStore): HistoryEntry[] {
  const next = withEntry(loadHistory(scope, store), entry)
  writePreference(key(scope), next, store)
  return next
}

export function clearHistory(scope: string, store?: PreferenceStore): void {
  removePreference(key(scope), store)
}

/** The entry as the server takes it: a statement past its bound is cut (a history is a memory aid, not an archive). */
export const forServer = (entry: HistoryEntry): HistoryEntry =>
  entry.sql.length > SQL_HISTORY_MAX_SQL ? { ...entry, sql: entry.sql.slice(0, SQL_HISTORY_MAX_SQL) } : entry
