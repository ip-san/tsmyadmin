import { z } from 'zod'

/** The statements EXPLAIN takes on both servers: not DDL, not a SET, not an EXPLAIN. */
export const EXPLAINABLE = /^\s*(?:(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|TABLE|VALUES)\b|\()/i

/** As long as a statement worth drawing gets; the SQL tab takes longer scripts, but a plan is of one statement. */
export const EXPLAIN_MAX_SQL = 100_000

export const ExplainRequestSchema = z.object({ sql: z.string().min(1).max(EXPLAIN_MAX_SQL) })

/** The longest a measured run may take by default, and at most: it runs the statement, so it is bounded. */
export const ANALYZE_TIMEOUT_DEFAULT_MS = 30_000
export const ANALYZE_TIMEOUT_MAX_MS = 300_000

/** A statement run to measure its plan: read only (SELECT, TABLE, VALUES, WITH … SELECT), and bounded in time. */
export const AnalyzeRequestSchema = ExplainRequestSchema.extend({
  timeoutMs: z.number().int().min(1000).max(ANALYZE_TIMEOUT_MAX_MS).default(ANALYZE_TIMEOUT_DEFAULT_MS),
  /** Registers the run, so `POST /sql/cancel` with this id stops it. */
  queryId: z.string().uuid().optional(),
})

/**
 * What a step did when the statement was run (`EXPLAIN ANALYZE`): the rows it gave each time it ran (`rows`, an
 * average where it ran more than once, like `estRows`), how many times it ran (`loops`), and the time until its
 * last row, all its runs together (`ms`; null where the server does not say). MySQL and PostgreSQL count the time
 * of the steps under it in a step's; MariaDB says a table's time only.
 */
export const PlanActualSchema = z.object({
  rows: z.number(),
  loops: z.number(),
  ms: z.number().nullable(),
})
export type PlanActual = z.infer<typeof PlanActualSchema>

/**
 * How a plan node reads its table: every row (`fullScan`), every entry of an index (`fullIndexScan`), a range of an
 * index (`range`), or the rows of a key value (`lookup`).
 */
export const PlanAccessSchema = z.enum(['fullScan', 'fullIndexScan', 'range', 'lookup', 'other'])
export type PlanAccess = z.infer<typeof PlanAccessSchema>

/**
 * One step of an execution plan, the same for every server. `table` is the table's own name where the server says
 * it or the statement does (`alias` is the name the statement gave it); a node that reads no table (a join, a sort)
 * has neither. `covering`: the index alone answers, the table is not read.
 */
export interface PlanNode {
  op: string
  table: string | null
  alias: string | null
  index: string | null
  /** The index columns the server says it used (MySQL); empty when it does not say. */
  indexColumns: string[]
  access: PlanAccess | null
  covering: boolean
  /** The rows the server expects the step to give. */
  estRows: number | null
  cost: number | null
  /** A condition or a note the server attached (an index condition, a filesort). */
  detail: string | null
  /** What the step did, where the statement was run to measure it; absent in an estimated plan. */
  actual?: PlanActual | undefined
  children: PlanNode[]
}
export const PlanNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    op: z.string(),
    table: z.string().nullable(),
    alias: z.string().nullable(),
    index: z.string().nullable(),
    indexColumns: z.array(z.string()),
    access: PlanAccessSchema.nullable(),
    covering: z.boolean(),
    estRows: z.number().nullable(),
    cost: z.number().nullable(),
    detail: z.string().nullable(),
    actual: PlanActualSchema.optional(),
    children: z.array(PlanNodeSchema),
  })
)

/** The raw plan is cut at this many characters: it is shown for reading, the tree is what is drawn. */
export const EXPLAIN_RAW_MAX = 64 * 1024

/**
 * A statement's plan, estimated without running it, or measured by running it (`measured`: the time the statement
 * took to run, null where the server does not say). `raw` is the server's own JSON.
 */
export const ExplainResultSchema = z.object({
  plan: PlanNodeSchema,
  raw: z.string(),
  rawTruncated: z.boolean(),
  measured: z.object({ ms: z.number().nullable() }).optional(),
})
export type ExplainResult = z.infer<typeof ExplainResultSchema>
