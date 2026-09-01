import { z } from 'zod'
import { BROWSE_MAX_LIMIT, type BrowseOptions, FilterSchema, SortSpecSchema } from './browse.ts'

/** Query-string form of BrowseOptions (GET /rows). */
export const BrowseQuerySchema = z.object({
  schema: z.string().min(1).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(BROWSE_MAX_LIMIT).default(100),
  /** "col:asc,col2:desc" */
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
        ? { column: s, direction: 'asc' }
        : { column: s.slice(0, idx), direction: s.slice(idx + 1).toLowerCase() }
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
  if (options.sort.length > 0) out.sort = options.sort.map((s) => `${s.column}:${s.direction}`).join(',')
  if (options.filters.length > 0) out.filters = JSON.stringify(options.filters)
  return out
}
