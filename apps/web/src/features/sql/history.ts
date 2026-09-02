import type { Dialect } from '@tsmyadmin/shared'
import { z } from 'zod'
import { type PreferenceStore, readPreference, removePreference, writePreference } from '@/lib/preferences.ts'

const HistoryEntrySchema = z.object({ sql: z.string(), at: z.number(), ok: z.boolean() })
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>
const ListSchema = z.array(HistoryEntrySchema)

export const HISTORY_LIMIT = 100
const key = (dialect: Dialect) => `sql.history.${dialect}`

/** Recent statements per dialect, in this browser (same storage convention as saved queries). */
export function loadHistory(dialect: Dialect, store?: PreferenceStore): HistoryEntry[] {
  return readPreference(key(dialect), ListSchema, [], store)
}

/** Prepends an entry (de-duplicating identical SQL) and trims to HISTORY_LIMIT. Returns the new list. */
export function pushHistory(dialect: Dialect, entry: HistoryEntry, store?: PreferenceStore): HistoryEntry[] {
  const next = [entry, ...loadHistory(dialect, store).filter((e) => e.sql !== entry.sql)].slice(0, HISTORY_LIMIT)
  writePreference(key(dialect), next, store)
  return next
}

export function clearHistory(dialect: Dialect, store?: PreferenceStore): void {
  removePreference(key(dialect), store)
}
