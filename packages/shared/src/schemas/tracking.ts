import { z } from 'zod'

/**
 * Change tracking (phpMyAdmin's Tracking), as snapshots: each version is the table's definition as the server
 * printed it when the version was recorded, with who recorded it and when. Shared by every account of the server;
 * the definition is always read by the server itself, never taken from the client.
 */
export const TrackedVersionSchema = z.object({
  id: z.string(),
  database: z.string(),
  schema: z.string().optional(),
  table: z.string(),
  version: z.number().int().min(1),
  /** The CREATE statement(s), one per line group, as SHOW CREATE / the catalog printed them. */
  definition: z.string(),
  /** The login name that recorded it. */
  by: z.string(),
  at: z.number(),
})
export type TrackedVersion = z.infer<typeof TrackedVersionSchema>

export const TrackingStateSchema = z.object({
  versions: z.array(TrackedVersionSchema),
  /** The definition now, to compare the latest version against. */
  current: z.string(),
})
export type TrackingState = z.infer<typeof TrackingStateSchema>

/** How the store addresses a version: per table, by number. */
export function trackedVersionKey(v: {
  database: string
  schema?: string | undefined
  table: string
  version: number
}) {
  return JSON.stringify([v.database, v.schema ?? '', v.table, v.version])
}

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/**
 * A line diff (longest common subsequence): what was removed from `before` and added in `after`. Definitions are
 * a few hundred lines at most, so the quadratic table is fine; beyond MAX_DIFF_LINES the two are shown whole, one
 * removed and one added, rather than spending seconds on it.
 */
export const MAX_DIFF_LINES = 4000

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  }
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array
    const next = lcs[i + 1] as Uint32Array
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' })
      i++
      j++
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) out.push({ kind: 'del', text: a[i++] ?? '' })
    else out.push({ kind: 'add', text: b[j++] ?? '' })
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] ?? '' })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] ?? '' })
  return out
}
