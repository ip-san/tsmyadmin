import { z } from 'zod'
import { CellSchema } from './cell.ts'
import { ResultSetSchema } from './result.ts'

export const SortDirectionSchema = z.enum(['asc', 'desc'])
export const SortSpecSchema = z.object({ column: z.string().min(1), direction: SortDirectionSchema })
export type SortSpec = z.infer<typeof SortSpecSchema>

export const FilterOpSchema = z.enum([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'like',
  'not_like',
  'is_null',
  'is_not_null',
])
export type FilterOp = z.infer<typeof FilterOpSchema>

export const FilterSchema = z.object({
  column: z.string().min(1),
  op: FilterOpSchema,
  value: CellSchema.optional(),
})
export type Filter = z.infer<typeof FilterSchema>

export const BROWSE_MAX_LIMIT = 1000

export const BrowseOptionsSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(BROWSE_MAX_LIMIT).default(100),
  sort: z.array(SortSpecSchema).default([]),
  filters: z.array(FilterSchema).default([]),
})
export type BrowseOptions = z.infer<typeof BrowseOptionsSchema>
export type BrowseOptionsInput = z.input<typeof BrowseOptionsSchema>

/** How rows of this table can be addressed for UPDATE/DELETE. */
export const RowKeyKindSchema = z.enum(['pk', 'ctid', 'all-columns', 'none'])
export type RowKeyKind = z.infer<typeof RowKeyKindSchema>

export const BrowseResultSchema = ResultSetSchema.extend({
  /** Exact COUNT(*) with the same filters, null when unavailable. */
  total: z.number().nullable(),
  keyKind: RowKeyKindSchema,
  /** For 'pk': key column names. For 'ctid': ['ctid'] (a hidden trailing column in rows). */
  keyColumns: z.array(z.string()),
})
export type BrowseResult = z.infer<typeof BrowseResultSchema>
