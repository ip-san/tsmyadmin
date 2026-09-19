import { BROWSE_MAX_LIMIT, type BrowseOptions, BrowseQuerySchema, parseBrowseQuery } from '@tsmyadmin/shared'
import { z } from 'zod'
import { sharePreference } from '@/lib/account-prefs.ts'
import { readPreference, removePreference, writePreference } from '@/lib/preferences.ts'

const DEFAULT_LIMIT = 50
const LimitSchema = z.number().int().min(1).max(BROWSE_MAX_LIMIT)
const LIMIT_PREF = 'browse.limit'

/** Page size remembered per browser; an explicit `?limit=` in the URL always wins (shareable links). */
export function preferredLimit(): number {
  return readPreference(LIMIT_PREF, LimitSchema, DEFAULT_LIMIT)
}
export function rememberLimit(limit: number): void {
  writePreference(LIMIT_PREF, limit)
  sharePreference({ browseLimit: limit })
}

export const BrowseSearchSchema = z.object({
  schema: z.string().optional(),
  page: z.number().int().min(1).default(1).catch(1),
  limit: LimitSchema.optional().catch(undefined),
  sort: z.string().optional().catch(undefined),
  filters: z.string().optional().catch(undefined),
  /** Comma-separated visible columns; omitted = all. */
  cols: z.string().optional().catch(undefined),
})
export type BrowseSearch = z.infer<typeof BrowseSearchSchema>

/** Converts the browse route's search params into BrowseOptions (invalid sort/filters fall back to none). */
export function browseOptionsFromSearch(s: BrowseSearch, limit = s.limit ?? preferredLimit()): BrowseOptions {
  const parsed = parseBrowseQuery(
    BrowseQuerySchema.parse({ offset: (s.page - 1) * limit, limit, sort: s.sort, filters: s.filters })
  )
  if (parsed.ok) return parsed.options
  return { offset: (s.page - 1) * limit, limit, sort: [], filters: [] }
}

/**
 * Column names to show, in the order given, or null when every column shows in the table's own order. Unknown
 * names are dropped.
 */
export function visibleColumnNames(cols: string | undefined, available: string[]): string[] | null {
  if (!cols) return null
  const known = new Set(available)
  const kept = [...new Set(cols.split(',').filter((c) => known.has(c)))]
  return kept.length === 0 || sameList(kept, available) ? null : kept
}

export function encodeColumns(selected: string[], available: string[]): string | undefined {
  return sameList(selected, available) ? undefined : selected.join(',')
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The columns chosen for a table (shown and in which order), remembered per browser like phpMyAdmin does. */
const colsKey = (db: string, schema: string | undefined, table: string) =>
  `browse.cols.${JSON.stringify([db, schema ?? '', table])}`
export function rememberedColumns(db: string, schema: string | undefined, table: string): string | undefined {
  return readPreference(colsKey(db, schema, table), z.string().optional(), undefined)
}
export function rememberColumns(db: string, schema: string | undefined, table: string, cols: string | undefined) {
  if (cols === undefined) removePreference(colsKey(db, schema, table))
  else writePreference(colsKey(db, schema, table), cols)
}
