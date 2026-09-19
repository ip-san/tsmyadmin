import { z } from 'zod'
import { CellSchema, InputCellSchema } from './cell.ts'
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
  /** Substring / prefix match: the server adds the wildcards and escapes % and _ in the value. */
  'contains',
  'starts_with',
  'like',
  'not_like',
  'is_null',
  'is_not_null',
  /** Against `values`: IN takes one or more, BETWEEN exactly two (low, high). */
  'in',
  'not_in',
  'between',
  'not_between',
  /** A regular expression in the server's own dialect (MySQL REGEXP, PostgreSQL `~`). */
  'regexp',
  'not_regexp',
  /** The empty string (not NULL), compared on the column's text form. */
  'empty',
  'not_empty',
])
export type FilterOp = z.infer<typeof FilterOpSchema>

/** Operators that take no value, and those that take `values` (a list) instead of `value`. */
export const NO_VALUE_OPS: ReadonlySet<FilterOp> = new Set(['is_null', 'is_not_null', 'empty', 'not_empty'])
export const LIST_OPS: ReadonlySet<FilterOp> = new Set(['in', 'not_in', 'between', 'not_between'])
/** Longest IN list one condition takes. */
export const FILTER_MAX_VALUES = 1000

export const FilterSchema = z.object({
  column: z.string().min(1),
  op: FilterOpSchema,
  value: InputCellSchema.optional(),
  /** For in / not_in / between / not_between only. */
  values: z.array(InputCellSchema).max(FILTER_MAX_VALUES).optional(),
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

/**
 * What `total` means: an exact COUNT(*); the catalog's estimate (large unfiltered table); or a floor — the
 * count stopped at EXACT_COUNT_MAX_ROWS matching rows so a filter over a huge table cannot scan it whole.
 */
export const CountKindSchema = z.enum(['exact', 'estimate', 'lower_bound'])
export type CountKind = z.infer<typeof CountKindSchema>

/**
 * The statement that fetched a page, exactly as it was sent: placeholders (`?` on MySQL, `$1`… on PostgreSQL)
 * with the bound values listed beside them.
 *
 * Never with the values spliced into the text. That string would look runnable, and making it runnable means
 * quoting each value for the dialect and the server's settings (MySQL's NO_BACKSLASH_ESCAPES changes what a
 * backslash means) — a guess, shown as if it were what ran.
 */
export const BrowseStatementSchema = z.object({
  sql: z.string(),
  params: z.array(CellSchema),
  /** The data query alone; the row count, when one is run, is not included. */
  durationMs: z.number().nonnegative(),
})
export type BrowseStatement = z.infer<typeof BrowseStatementSchema>

export const BrowseResultSchema = ResultSetSchema.extend({
  /** Row count with the same filters, null when unavailable; `count` says how exact it is. */
  total: z.number().nullable(),
  count: CountKindSchema,
  keyKind: RowKeyKindSchema,
  /** For 'pk': key column names. For 'ctid': ['ctid'] (a hidden trailing column in rows). */
  keyColumns: z.array(z.string()),
  /** Outgoing foreign keys, so cells can link to the referenced row (single-column keys only are linkable). */
  foreignKeys: z.array(ForeignKeyDefSchema),
  /** Reverse references, so a row can link to the rows that point at it. */
  referencedBy: z.array(ReferencingKeyDefSchema),
  statement: BrowseStatementSchema,
})
export type BrowseResult = z.infer<typeof BrowseResultSchema>

/** Longest term the database-wide search accepts. */
export const SEARCH_TERM_MAX = 200

/**
 * How a database-wide search reads its term (phpMyAdmin's "Find"): the words as one phrase; any of the words; all
 * of them (anywhere in the row); or a regular expression in the server's own dialect.
 */
export const SearchModeSchema = z.enum(['phrase', 'any', 'all', 'regexp'])
export type SearchMode = z.infer<typeof SearchModeSchema>
export interface SearchOptions {
  mode?: SearchMode
  /** Only columns whose name contains this (case-insensitive). */
  column?: string
}

export const TableSearchQuerySchema = z.object({
  q: z
    .string()
    .min(1)
    .max(SEARCH_TERM_MAX)
    // PostgreSQL cannot hold NUL in text at all, so every table would fail with an encoding error.
    .refine((s) => !s.includes('\0'), 'The search term cannot contain a NUL character'),
  schema: z.string().min(1).optional(),
  mode: SearchModeSchema.default('phrase'),
  column: z.string().max(64).optional(),
})
export type TableSearchQuery = z.infer<typeof TableSearchQuerySchema>

/**
 * One table's share of a database-wide search: how many rows contain the term in any searchable column.
 *
 * `count` is `exact` or `lower_bound` — the count stops at EXACT_COUNT_MAX_ROWS, as the browse count does, so a
 * term matching most of a huge table costs one bounded scan. `columns` lists what was searched (binary and
 * spatial columns are not). `sql` is a SELECT for the SQL tab with the term written in as a literal, because it
 * is meant to be edited and run; it is not a record of what the count ran, which bound the term as a parameter.
 */
export const TableSearchResultSchema = z.object({
  total: z.number(),
  count: CountKindSchema,
  columns: z.array(z.string()),
  sql: z.string(),
})
export type TableSearchResult = z.infer<typeof TableSearchResultSchema>
