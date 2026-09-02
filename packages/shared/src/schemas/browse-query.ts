import { z } from 'zod'
import { BROWSE_MAX_LIMIT, type BrowseOptions, FilterSchema, SortSpecSchema } from './browse.ts'

/** Query-string form of BrowseOptions (GET /rows). */
export const BrowseQuerySchema = z.object({
  schema: z.string().min(1).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(BROWSE_MAX_LIMIT).default(100),
  /** "col:asc,col2:desc" — column names are percent-encoded so `,` / `:` / `%` in a name survive (see encodeSort) */
  sort: z.string().optional(),
  /** JSON-encoded Filter[] */
  filters: z.string().optional(),
})
export type BrowseQuery = z.infer<typeof BrowseQuerySchema>
export type BrowseQueryInput = z.input<typeof BrowseQuerySchema>

const SortListSchema = z.array(SortSpecSchema)
const FilterListSchema = z.array(FilterSchema)

export type ParsedBrowseQuery = { ok: true; options: BrowseOptions } | { ok: false; message: string }

export function parseBrowseQuery(q: BrowseQuery): ParsedBrowseQuery {
  const sortRaw = (q.sort ?? '')
    .split(',')
    .filter((s) => s.length > 0)
    .map((s) => {
      const idx = s.lastIndexOf(':')
      return idx === -1
        ? { column: decodeColumn(s), direction: 'asc' }
        : { column: decodeColumn(s.slice(0, idx)), direction: s.slice(idx + 1).toLowerCase() }
    })
  const sort = SortListSchema.safeParse(sortRaw)
  if (!sort.success) return { ok: false, message: `Invalid sort: ${sort.error.issues[0]?.message ?? 'malformed'}` }
  let filtersRaw: unknown = []
  if (q.filters) {
    try {
      filtersRaw = JSON.parse(q.filters)
    } catch {
      return { ok: false, message: 'Invalid filters: not JSON' }
    }
  }
  const filters = FilterListSchema.safeParse(filtersRaw)
  if (!filters.success)
    return { ok: false, message: `Invalid filters: ${filters.error.issues[0]?.message ?? 'malformed'}` }
  return { ok: true, options: { offset: q.offset, limit: q.limit, sort: sort.data, filters: filters.data } }
}

/** Inverse of parseBrowseQuery, for clients building the query string. */
export function buildBrowseQuery(options: BrowseOptions, schema?: string): Record<string, string> {
  const out: Record<string, string> = { offset: String(options.offset), limit: String(options.limit) }
  if (schema) out.schema = schema
  if (options.sort.length > 0) out.sort = encodeSort(options.sort)
  if (options.filters.length > 0) out.filters = JSON.stringify(options.filters)
  return out
}

/** Query-string form of a sort list: readable `name:asc`, with the separators escaped inside column names. */
export function encodeSort(sort: BrowseOptions['sort']): string {
  return sort.map((s) => `${encodeURIComponent(s.column)}:${s.direction}`).join(',')
}

/** Inverse of encodeSort's column escaping; a name that is not valid percent-encoding is taken literally. */
function decodeColumn(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
