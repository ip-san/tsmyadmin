import { maskConnectionPassword, maskCredentialPart, type StatementResult } from '@tsmyadmin/shared'
import { useSyncExternalStore } from 'react'

/** One statement this page sent to the server. */
export interface DebugEntry {
  id: number
  at: number
  ms: number | null
  ok: boolean
  /** As shown (passwords masked). */
  sql: string
  /** What to run again: the statement with its values written in where the page sent placeholders. */
  rerun: string
}

export const DEBUG_SQL_MAX = 200

/**
 * A statement with the secrets of an account statement masked, by the same rule as the server's audit log (shared in
 * `maskCredentialPart`). Coarser than the server's, which splits statements first: it may hide more, never less.
 */
export function maskSql(sql: string): string {
  return maskCredentialPart(maskConnectionPassword(sql))
}

let entries: readonly DebugEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

/** Notes a statement the page sent (newest last; the oldest go once there are more than DEBUG_SQL_MAX). */
export function recordSql(sql: string, ms: number | null, ok: boolean, rerun: string = sql): void {
  const entry: DebugEntry = { id: nextId++, at: Date.now(), ms, ok, sql: maskSql(sql), rerun: maskSql(rerun) }
  entries = [...entries, entry].slice(-DEBUG_SQL_MAX)
  for (const l of listeners) l()
}

/** Notes a finished statement (its own timing where the server gave one). */
export function recordStatement(r: StatementResult): void {
  recordSql(r.sql, r.kind === 'error' ? null : r.durationMs, r.kind !== 'error')
}

export function clearDebugSql(): void {
  entries = []
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useDebugSql = (): readonly DebugEntry[] =>
  useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries
  )
