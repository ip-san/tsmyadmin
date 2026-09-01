import type { Dialect } from '@tsmyadmin/shared'

export interface HistoryEntry {
  sql: string
  at: number
  ok: boolean
}

export const HISTORY_LIMIT = 100
const key = (dialect: Dialect) => `tsmyadmin.sqlHistory.${dialect}`

export function loadHistory(dialect: Dialect, storage: Pick<Storage, 'getItem'> = localStorage): HistoryEntry[] {
  try {
    const raw = storage.getItem(key(dialect))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is HistoryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof e.sql === 'string' &&
        typeof e.at === 'number' &&
        typeof e.ok === 'boolean'
    )
  } catch {
    return []
  }
}

/** Prepends an entry (de-duplicating identical SQL) and trims to HISTORY_LIMIT. Returns the new list. */
export function pushHistory(
  dialect: Dialect,
  entry: HistoryEntry,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage
): HistoryEntry[] {
  const next = [entry, ...loadHistory(dialect, storage).filter((e) => e.sql !== entry.sql)].slice(0, HISTORY_LIMIT)
  try {
    storage.setItem(key(dialect), JSON.stringify(next))
  } catch {
    // storage full or unavailable: history is best-effort
  }
  return next
}

export function clearHistory(dialect: Dialect, storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(key(dialect))
  } catch {
    // ignore
  }
}
