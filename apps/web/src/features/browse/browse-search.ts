import { BROWSE_MAX_LIMIT, type BrowseOptions, BrowseQuerySchema, parseBrowseQuery } from '@tsmyadmin/shared'
import { z } from 'zod'

export const BrowseSearchSchema = z.object({
  schema: z.string().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(BROWSE_MAX_LIMIT).default(50),
  sort: z.string().optional(),
  filters: z.string().optional(),
})
export type BrowseSearch = z.infer<typeof BrowseSearchSchema>

/** Converts the browse route's search params into BrowseOptions (invalid sort/filters fall back to none). */
export function browseOptionsFromSearch(s: BrowseSearch): BrowseOptions {
  const parsed = parseBrowseQuery(
    BrowseQuerySchema.parse({ offset: (s.page - 1) * s.limit, limit: s.limit, sort: s.sort, filters: s.filters })
  )
  if (parsed.ok) return parsed.options
  return { offset: (s.page - 1) * s.limit, limit: s.limit, sort: [], filters: [] }
}
