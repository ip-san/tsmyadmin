import { BROWSE_MAX_LIMIT, type BrowseOptions, BrowseQuerySchema, parseBrowseQuery } from '@tsmyadmin/shared'
import { z } from 'zod'
import { readPreference, writePreference } from '@/lib/preferences.ts'

const DEFAULT_LIMIT = 50
const LimitSchema = z.number().int().min(1).max(BROWSE_MAX_LIMIT)
const LIMIT_PREF = 'browse.limit'

/** Page size remembered per browser; an explicit `?limit=` in the URL always wins (shareable links). */
export function preferredLimit(): number {
  return readPreference(LIMIT_PREF, LimitSchema, DEFAULT_LIMIT)
}
export function rememberLimit(limit: number): void {
  writePreference(LIMIT_PREF, limit)
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

/** Column names to show, or null when every column is visible. Unknown names are dropped. */
export function visibleColumnNames(cols: string | undefined, available: string[]): string[] | null {
  if (!cols) return null
  const wanted = new Set(cols.split(',').filter((c) => c.length > 0))
  const kept = available.filter((c) => wanted.has(c))
  return kept.length === available.length ? null : kept
}

export function encodeColumns(selected: string[], available: string[]): string | undefined {
  return selected.length === available.length ? undefined : selected.join(',')
}
