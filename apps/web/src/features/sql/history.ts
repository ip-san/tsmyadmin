import { z } from 'zod'
import { type PreferenceStore, readPreference, removePreference, writePreference } from '@/lib/preferences.ts'
import { historyLimit } from '@/lib/settings.ts'

const HistoryEntrySchema = z.object({ sql: z.string(), at: z.number(), ok: z.boolean(), db: z.string().optional() })
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>
const ListSchema = z.array(HistoryEntrySchema)

/** `scope` identifies the server (dialect:host:port): two MySQL servers must not share one list. */
const key = (scope: string) => `sql.history.${scope}`

/** Recent statements per dialect, in this browser (same storage convention as saved queries). */
export function loadHistory(scope: string, store?: PreferenceStore): HistoryEntry[] {
  return readPreference(key(scope), ListSchema, [], store)
}

/** Prepends an entry (de-duplicating identical SQL) and trims to the limit in the settings. Returns the new list. */
export function pushHistory(scope: string, entry: HistoryEntry, store?: PreferenceStore): HistoryEntry[] {
  const next = [entry, ...loadHistory(scope, store).filter((e) => e.sql !== entry.sql)].slice(0, historyLimit())
  writePreference(key(scope), next, store)
  return next
}

export function clearHistory(scope: string, store?: PreferenceStore): void {
  removePreference(key(scope), store)
}
