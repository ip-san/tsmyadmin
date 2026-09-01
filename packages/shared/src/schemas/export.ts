import { z } from 'zod'

export const ExportFormatSchema = z.enum(['sql', 'csv', 'json'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

const flag = z.enum(['0', '1'])

/** Query string of GET /databases/:db/export (a navigation download, so everything is a string). */
export const ExportQuerySchema = z.object({
  schema: z.string().min(1).optional(),
  /** Comma-separated table names; empty/omitted = every table in the namespace. */
  tables: z.string().optional(),
  format: ExportFormatSchema.default('sql'),
  structure: flag.default('1'),
  data: flag.default('1'),
  /** UTF-8 BOM for CSV (Excel). */
  bom: flag.default('1'),
})
export type ExportQuery = z.infer<typeof ExportQuerySchema>
export type ExportQueryInput = z.input<typeof ExportQuerySchema>

/** NULL marker used in CSV exports (phpMyAdmin default). */
export const CSV_NULL = '\\N'
export const EXPORT_BATCH_SIZE = 500
