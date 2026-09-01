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

export const StatementResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rows'), sql: z.string(), result: ResultSetSchema, durationMs: z.number() }),
  z.object({ kind: z.literal('affected'), sql: z.string(), affectedRows: z.number(), durationMs: z.number() }),
  z.object({
    kind: z.literal('error'),
    sql: z.string(),
    message: z.string(),
    code: z.string().optional(),
    /** Driver / server error code (MySQL ER_*, PostgreSQL SQLSTATE). */
    nativeCode: z.string().optional(),
    /** 1-based character offset of the error inside `sql` (PostgreSQL reports it; MySQL does not). */
    position: z.number().int().min(1).optional(),
  }),
])
export type StatementResult = z.infer<typeof StatementResultSchema>
