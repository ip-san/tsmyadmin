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
