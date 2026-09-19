import { z } from 'zod'
import { FILTER_MAX_VALUES, FilterOpSchema, SortDirectionSchema } from './browse.ts'

/** Bounds on one query, so a request cannot make the server describe or join an unbounded set of tables. */
export const QUERY_BUILDER_MAX_TABLES = 10
export const QUERY_BUILDER_MAX_COLUMNS = 50
export const QUERY_BUILDER_MAX_GROUPS = 10
export const QUERY_BUILDER_MAX_CONDITIONS = 20
export const QUERY_BUILDER_MAX_WHERE_SQL = 10_000

const ColumnRefSchema = z.object({ table: z.string().min(1), column: z.string().min(1) })

/**
 * What a condition can say: every condition is a column, an operator and a value (or a list of them), and the
 * server writes the SQL. Anything beyond that is edited in the SQL tab, where the generated statement opens.
 */
export const QueryBuilderOpSchema = FilterOpSchema
export type QueryBuilderOp = z.infer<typeof QueryBuilderOpSchema>

export const QueryBuilderColumnSchema = ColumnRefSchema.extend({
  /** Output name (`AS`); empty for none. */
  alias: z.string().max(64).default(''),
  /** In the SELECT list. A column can be listed only to sort by it. */
  show: z.boolean().default(true),
  sort: SortDirectionSchema.nullable().default(null),
})

const LiteralSchema = z
  .string()
  .max(1000)
  .refine((s) => !s.includes('\0'), 'A value cannot contain a NUL character')

export const QueryBuilderConditionSchema = ColumnRefSchema.extend({
  op: QueryBuilderOpSchema,
  /** Ignored for operators without a value; required otherwise. Written into the SQL as a quoted literal. */
  value: LiteralSchema.optional(),
  /** For in / not_in / between / not_between. */
  values: z.array(LiteralSchema).max(FILTER_MAX_VALUES).optional(),
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
  /**
   * Joins spelled out (phpMyAdmin's "Relationship" rows): how a table joins the ones before it. A table without
   * one is joined along a foreign key, as before.
   */
  joins: z
    .array(
      z.object({
        table: z.string().min(1),
        kind: z.enum(['inner', 'left', 'right']).default('inner'),
        on: z
          .array(z.object({ from: ColumnRefSchema, to: ColumnRefSchema }))
          .min(1)
          .max(10),
      })
    )
    .max(QUERY_BUILDER_MAX_TABLES)
    .default([]),
  /** SELECT DISTINCT. */
  distinct: z.boolean().default(false),
  /**
   * Conditions typed as SQL (the body of a WHERE clause), AND-ed with the rest. Written into the statement as
   * typed: it only builds text for the SQL tab, which runs it as the user's own SQL.
   */
  whereSql: z.string().max(QUERY_BUILDER_MAX_WHERE_SQL).default(''),
  /** LIMIT; null for none. */
  limit: z.number().int().min(1).max(1_000_000).nullable().default(null),
})
export type QueryBuilderRequest = z.infer<typeof QueryBuilderRequestSchema>
export type QueryBuilderRequestInput = z.input<typeof QueryBuilderRequestSchema>
/** The request without its namespace, which the adapter receives separately; the options may be left out. */
export type QueryBuilderSpec = Omit<QueryBuilderRequest, 'schema' | 'distinct' | 'whereSql' | 'limit' | 'joins'> &
  Partial<Pick<QueryBuilderRequest, 'distinct' | 'whereSql' | 'limit' | 'joins'>>
export type QueryBuilderJoin = QueryBuilderRequest['joins'][number]

/** A SELECT for the SQL tab. Nothing is run to produce it beyond reading the tables' structure. */
export const QueryBuilderResultSchema = z.object({ sql: z.string() })
export type QueryBuilderResult = z.infer<typeof QueryBuilderResultSchema>

/**
 * A query-builder setup kept under a name (phpMyAdmin's saved searches in "Query by example"): the tables,
 * columns, conditions and joins, for one database (and schema). Restored into the form, not run.
 */
export const QueryTemplateBodySchema = z.object({
  database: z.string().min(1).max(256),
  schema: z.string().min(1).max(256).optional(),
  request: QueryBuilderRequestSchema.omit({ schema: true }),
})
export type QueryTemplateBody = z.infer<typeof QueryTemplateBodySchema>
export const QueryTemplateSchema = QueryTemplateBodySchema.extend({
  id: z.string().default(''),
  name: z.string().min(1).max(200),
  at: z.number(),
})
export type QueryTemplate = z.infer<typeof QueryTemplateSchema>
export const SaveQueryTemplateRequestSchema = QueryTemplateBodySchema.extend({ name: z.string().min(1).max(200) })
export type SaveQueryTemplateRequest = z.infer<typeof SaveQueryTemplateRequestSchema>
export const queryTemplateKey = (t: { database: string; schema?: string | undefined; name: string }) =>
  JSON.stringify([t.database, t.schema ?? '', t.name])
