import { z } from 'zod'
import { CellSchema } from './cell.ts'

export const ColumnMetaSchema = z.object({
  name: z.string(),
  /** Dialect-native type name as reported by the driver (e.g. "varchar", "int8"). */
  dataType: z.string(),
})
export type ColumnMeta = z.infer<typeof ColumnMetaSchema>

export const ResultSetSchema = z.object({
  columns: z.array(ColumnMetaSchema),
  /** Rows as arrays so duplicate column names (JOINs) survive. */
  rows: z.array(z.array(CellSchema)),
  truncated: z.boolean(),
})
export type ResultSet = z.infer<typeof ResultSetSchema>

/** 1-based line of the script where the statement starts (imports and long scripts). */
const line = z.number().int().min(1).optional()
/** 0-based index of the statement in the script; the several result sets of one CALL share it. */
const statement = z.number().int().min(0).optional()
/** Server-side NOTICE / WARNING messages raised by the statement (PostgreSQL); a "success" may hide one. */
const notices = z.array(z.string()).optional()

export const StatementResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rows'),
    sql: z.string(),
    result: ResultSetSchema,
    durationMs: z.number(),
    line,
    statement,
    notices,
  }),
  z.object({
    kind: z.literal('affected'),
    sql: z.string(),
    affectedRows: z.number(),
    durationMs: z.number(),
    line,
    statement,
    notices,
  }),
  z.object({
    kind: z.literal('error'),
    sql: z.string(),
    line,
    statement,
    message: z.string(),
    code: z.string().optional(),
    /** Driver / server error code (MySQL ER_*, PostgreSQL SQLSTATE). */
    nativeCode: z.string().optional(),
    /** 1-based character offset of the error inside `sql` (PostgreSQL reports it; MySQL does not). */
    position: z.number().int().min(1).optional(),
  }),
])
export type StatementResult = z.infer<typeof StatementResultSchema>
