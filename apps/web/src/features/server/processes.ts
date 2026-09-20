import type { ProcessInfo } from '@tsmyadmin/shared'

/** The intervals the page can refresh at, in seconds. */
export const REFRESH_SECONDS = [2, 5, 10, 30] as const

/**
 * Whether a connection is doing something: not a MySQL `Sleep` nor a PostgreSQL `idle` one. An `idle in
 * transaction` session stays: it is not running a statement, but it is holding locks, which is what a person
 * looking for the cause of a stall wants to see.
 */
export function isActiveProcess(p: Pick<ProcessInfo, 'state'>): boolean {
  return !/^(?:sleep|idle)\b(?!\s+in\s+transaction)/i.test((p.state ?? '').trim())
}

export type ProcessColumn = 'id' | 'user' | 'host' | 'database' | 'state' | 'timeSec' | 'query'

/** The list ordered by one column: numbers as numbers (ids are digits), text by locale, empty values last either way. */
export function sortProcesses(list: readonly ProcessInfo[], column: ProcessColumn, dir: 'asc' | 'desc'): ProcessInfo[] {
  const value = (p: ProcessInfo): number | string | null =>
    column === 'id' ? Number(p.id) : column === 'timeSec' ? p.timeSec : p[column]
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)))
  })
}

/** The statement on one line, cut to `limit` characters unless the whole text is asked for. */
export function abbreviateQuery(query: string, full: boolean, limit = 100): string {
  if (full || query.length <= limit) return query
  return `${query.slice(0, limit)}…`
}
