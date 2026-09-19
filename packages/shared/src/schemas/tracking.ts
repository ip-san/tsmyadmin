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

/**
 * The longest definition a version keeps. Every stored body has a bound; without one, a table with thousands of
 * partitions (a multi-megabyte SHOW CREATE TABLE) times the server's allowance of versions would fill the store.
 */
export const TRACKING_DEFINITION_MAX = 64 * 1024

/**
 * The kinds of statement that can be recorded against a tracked table (phpMyAdmin's "Tracking statements"): the
 * definition changes and the row changes. Only what runs through this tool is seen — statements from other
 * clients show up only as differences between versions.
 */
export const TRACK_DDL_KINDS = ['create', 'alter', 'rename', 'drop', 'truncate', 'index'] as const
export const TRACK_DML_KINDS = ['insert', 'update', 'delete'] as const
export const TrackKindSchema = z.enum([...TRACK_DDL_KINDS, ...TRACK_DML_KINDS])
export type TrackKind = z.infer<typeof TrackKindSchema>
/** What a table records when tracking starts: the definition changes (row changes carry values; opt in). */
export const DEFAULT_TRACK_KINDS: TrackKind[] = [...TRACK_DDL_KINDS]

export const TrackingKindsRequestSchema = z.object({ kinds: z.array(TrackKindSchema).max(20) })

/** The longest statement text kept per entry; longer text is cut, and marked so. */
export const TRACKED_STATEMENT_MAX = 16 * 1024

/**
 * One statement recorded against a tracked table: its text as it ran (from the SQL console or a preview), or, for
 * a row changed in the grid, what was done without the values (`statement` null, `rows` / `columns` given).
 */
export const TrackedStatementSchema = z.object({
  id: z.string(),
  kind: TrackKindSchema,
  statement: z.string().nullable(),
  truncated: z.boolean().default(false),
  rows: z.number().int().min(0).optional(),
  columns: z.array(z.string()).optional(),
  by: z.string(),
  at: z.number(),
})
export type TrackedStatement = z.infer<typeof TrackedStatementSchema>

export const TrackingStateSchema = z.object({
  versions: z.array(TrackedVersionSchema),
  /** The definition now, to compare the latest version against. */
  current: z.string(),
  /** The statement kinds this table records. */
  kinds: z.array(TrackKindSchema).default([]),
  /** Newest first; null when the viewer cannot read the table's rows (a statement may hold row values). */
  log: z.array(TrackedStatementSchema).nullable().default([]),
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

/** A table tracked in a database / schema, for its list (phpMyAdmin's database-level Tracking page). */
export const TrackedTableSchema = z.object({
  table: z.string(),
  versions: z.number().int(),
  latest: z.number().int(),
  at: z.number(),
  kinds: z.array(TrackKindSchema),
})
export type TrackedTable = z.infer<typeof TrackedTableSchema>

/** One part of a table name as a statement writes it: plain, `back-quoted` or "double-quoted". */
const PART = '(?:[\\w$]+|`(?:[^`]|``)+`|"(?:[^"]|"")+")'
/** A table name: one part, or two (`db`.`t`, "schema"."t"). */
const NAME = `(${PART}(?:\\s*\\.\\s*${PART})?)`
const rx = (head: string, tail = '') => new RegExp(`^${head}${NAME}${tail}`, 'i')
const PATTERNS: [TrackKind, RegExp][] = [
  ['create', rx('CREATE\\s+(?:(?:GLOBAL|LOCAL|TEMPORARY|TEMP|UNLOGGED)\\s+)*TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?')],
  ['index', rx('CREATE\\s+(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?INDEX\\b[\\s\\S]*?\\bON\\s+(?:ONLY\\s+)?')],
  ['index', rx('DROP\\s+INDEX\\s+\\S+\\s+ON\\s+')],
  ['rename', rx('ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?', '\\s+RENAME\\s+TO\\b')],
  ['alter', rx('ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?')],
  ['rename', rx('RENAME\\s+TABLE\\s+')],
  ['drop', rx('DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?')],
  ['truncate', rx('TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?')],
  ['insert', rx('(?:INSERT|REPLACE)\\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\\s+)*(?:INTO\\s+)?')],
  ['update', rx('UPDATE\\s+(?:(?:LOW_PRIORITY|IGNORE|ONLY)\\s+)*')],
  ['delete', rx('DELETE\\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\\s+)*FROM\\s+(?:ONLY\\s+)?')],
]
const PARTS = new RegExp(PART, 'g')

function unquote(part: string): string {
  if (part.startsWith('`')) return part.slice(1, -1).replaceAll('``', '`')
  if (part.startsWith('"')) return part.slice(1, -1).replaceAll('""', '"')
  return part
}

/**
 * What a statement does to which table, for tracking: its kind, the table and — when the statement names one —
 * the database (MySQL) or schema (PostgreSQL) it qualifies it with. Null for anything else (SELECT, a routine…).
 * Leading comments are skipped; the first table named is the one it acts on.
 */
export function classifyStatement(sql: string): { kind: TrackKind; table: string; qualifier?: string } | null {
  const text = sql.replace(/^(?:\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '')
  for (const [kind, re] of PATTERNS) {
    const name = re.exec(text)?.[1]
    if (!name) continue
    const parts = (name.match(PARTS) ?? []).map(unquote)
    const table = parts.at(-1) ?? ''
    return parts.length > 1 ? { kind, table, qualifier: parts[0] ?? '' } : { kind, table }
  }
  return null
}
