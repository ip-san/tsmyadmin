/** Catalog-row value normalisers shared by introspection and server queries. */
import type { LockWait, ObjectDependency } from '@tsmyadmin/shared'
/** Builds ObjectDependency entries from (kind, name, refKind, refName) rows, dropping self-references. */
export function groupDependencies(
  rows: { kind: 'view' | 'routine'; name: string; refKind: 'table' | 'view' | 'routine'; refName: string }[]
): ObjectDependency[] {
  const byKey = new Map<string, ObjectDependency>()
  for (const r of rows) {
    if (r.kind === r.refKind && r.name === r.refName) continue
    const key = `${r.kind}:${r.name}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = { kind: r.kind, name: r.name, dependsOn: [] }
      byKey.set(key, entry)
    }
    entry.dependsOn.push({ kind: r.refKind, name: r.refName })
  }
  return [...byKey.values()]
}

export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
/** Joins optional parts with " / ", or null when all are empty (e.g. COMMAND / STATE). */
export const joinParts = (...parts: unknown[]): string | null =>
  parts
    .map(strOrNull)
    .filter((x): x is string => !!x)
    .join(' / ') || null

const seconds = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** What PostgreSQL shows in place of another account's statement when this one may not read it. */
const hidden = (v: unknown): string | null => {
  const s = strOrNull(v)
  return s === '<insufficient privilege>' ? null : s
}

/**
 * One row of a lock-wait query as a LockWait. Both dialects select the same columns, in this order: blocked id,
 * user, database, seconds waited, statement; blocking id, user, database, state, idle in transaction, seconds its
 * transaction has been open, statement; the table and the mode of the waited-for lock.
 */
export function lockWaitFromRow(row: unknown[]): LockWait {
  return {
    blocked: {
      id: str(row[0]),
      user: strOrNull(row[1]),
      database: strOrNull(row[2]),
      waitSec: seconds(row[3]),
      query: hidden(row[4]),
    },
    blocking: {
      id: str(row[5]),
      user: strOrNull(row[6]),
      database: strOrNull(row[7]),
      state: strOrNull(row[8]),
      idleInTransaction: row[9] === true || Number(row[9]) === 1,
      transactionSec: seconds(row[10]),
      query: hidden(row[11]),
    },
    table: strOrNull(row[12]),
    mode: strOrNull(row[13]),
  }
}
