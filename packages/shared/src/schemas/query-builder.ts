import { z } from 'zod'
import { FilterOpSchema, SortDirectionSchema } from './browse.ts'

/** Bounds on one query, so a request cannot make the server describe or join an unbounded set of tables. */
export const QUERY_BUILDER_MAX_TABLES = 10
export const QUERY_BUILDER_MAX_COLUMNS = 50
export const QUERY_BUILDER_MAX_GROUPS = 10
export const QUERY_BUILDER_MAX_CONDITIONS = 20

const ColumnRefSchema = z.object({ table: z.string().min(1), column: z.string().min(1) })

/**
 * What a condition can say. `like` / `not_like` are left out on purpose, as is any free-text criterion: every
 * condition is a column, an operator and a value, and the server writes the SQL. Anything beyond that is edited
 * in the SQL tab, where the generated statement opens.
 */
export const QueryBuilderOpSchema = FilterOpSchema.exclude(['like', 'not_like'])
export type QueryBuilderOp = z.infer<typeof QueryBuilderOpSchema>

export const QueryBuilderColumnSchema = ColumnRefSchema.extend({
  /** Output name (`AS`); empty for none. */
  alias: z.string().max(64).default(''),
  /** In the SELECT list. A column can be listed only to sort by it. */
  show: z.boolean().default(true),
  sort: SortDirectionSchema.nullable().default(null),
})

export const QueryBuilderConditionSchema = ColumnRefSchema.extend({
  op: QueryBuilderOpSchema,
  /** Ignored for is_null / is_not_null; required otherwise. Written into the SQL as a quoted literal. */
  value: z
    .string()
    .max(1000)
    .refine((s) => !s.includes('\0'), 'A value cannot contain a NUL character')
    .optional(),
})
export type QueryBuilderCondition = z.infer<typeof QueryBuilderConditionSchema>

export const QueryBuilderRequestSchema = z.object({
  schema: z.string().min(1).optional(),
  /** The first table is the one the others are joined to, along foreign keys. */
  tables: z.array(z.string().min(1)).min(1).max(QUERY_BUILDER_MAX_TABLES),
  columns: z.array(QueryBuilderColumnSchema).max(QUERY_BUILDER_MAX_COLUMNS).default([]),
  /** OR of groups; each group is an AND of its conditions. */
  where: z
    .array(z.array(QueryBuilderConditionSchema).min(1).max(QUERY_BUILDER_MAX_CONDITIONS))
    .max(QUERY_BUILDER_MAX_GROUPS)
    .default([]),
})
export type QueryBuilderRequest = z.infer<typeof QueryBuilderRequestSchema>
export type QueryBuilderRequestInput = z.input<typeof QueryBuilderRequestSchema>
/** The request without its namespace, which the adapter receives separately. */
export type QueryBuilderSpec = Omit<QueryBuilderRequest, 'schema'>

/** A SELECT for the SQL tab. Nothing is run to produce it beyond reading the tables' structure. */
export const QueryBuilderResultSchema = z.object({ sql: z.string() })
export type QueryBuilderResult = z.infer<typeof QueryBuilderResultSchema>
