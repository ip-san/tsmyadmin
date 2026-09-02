import { z } from 'zod'
import { CellSchema } from './cell.ts'
import { ResultSetSchema } from './result.ts'
import { ForeignKeyDefSchema, ReferencingKeyDefSchema } from './structure.ts'

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

/** Tables whose catalog estimate exceeds this are not COUNT(*)ed on unfiltered browses (phpMyAdmin behaves the same). */
export const EXACT_COUNT_MAX_ROWS = 100_000

export const BrowseResultSchema = ResultSetSchema.extend({
  /** Row count with the same filters, null when unavailable. Approximate when `approximate` is true. */
  total: z.number().nullable(),
  /** True when `total` is the catalog's estimate (large unfiltered table) instead of an exact COUNT(*). */
  approximate: z.boolean(),
  keyKind: RowKeyKindSchema,
  /** For 'pk': key column names. For 'ctid': ['ctid'] (a hidden trailing column in rows). */
  keyColumns: z.array(z.string()),
  /** Outgoing foreign keys, so cells can link to the referenced row (single-column keys only are linkable). */
  foreignKeys: z.array(ForeignKeyDefSchema),
  /** Reverse references, so a row can link to the rows that point at it. */
  referencedBy: z.array(ReferencingKeyDefSchema),
})
export type BrowseResult = z.infer<typeof BrowseResultSchema>
