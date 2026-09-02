import { z } from 'zod'
import { FlagSchema } from './common.ts'

export const ExportFormatSchema = z.enum(['sql', 'csv', 'json'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

/** Query string of GET /databases/:db/export (a navigation download, so everything is a string). */
export const ExportQuerySchema = z.object({
  schema: z.string().min(1).optional(),
  /** Comma-separated table names; empty/omitted = every table in the namespace. */
  tables: z.string().optional(),
  format: ExportFormatSchema.default('sql'),
  structure: FlagSchema.default('1'),
  /**
   * Emit DROP … IF EXISTS so the dump restores over an existing schema: before each CREATE on MySQL, as one
   * dependency-ordered section at the top on PostgreSQL.
   */
  dropTable: FlagSchema.default('1'),
  data: FlagSchema.default('1'),
  /** UTF-8 BOM for CSV (Excel). */
  bom: FlagSchema.default('1'),
  /** SQL: include stored routines, triggers and events (triggers of the requested tables when tables are named). */
  routines: FlagSchema.default('1'),
  /** SQL (MySQL): drop `DEFINER=...` clauses so the dump restores under another account. */
  stripDefiner: FlagSchema.default('0'),
})
export type ExportQuery = z.infer<typeof ExportQuerySchema>
export type ExportQueryInput = z.input<typeof ExportQuerySchema>

/** NULL marker used in CSV exports (phpMyAdmin default). */
/** Query-string form of a table list: names percent-encoded so `,` (and leading spaces) survive; deduplicated. */
export function encodeTableList(tables: string[]): string {
  return [...new Set(tables)].map((t) => encodeURIComponent(t)).join(',')
}

export function decodeTableList(text: string | undefined): string[] {
  const out: string[] = []
  for (const part of (text ?? '').split(',')) {
    if (part.length === 0) continue
    let name = part
    try {
      name = decodeURIComponent(part)
    } catch {
      // not an escape sequence: the name is taken as written
    }
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export const CSV_NULL = '\\N'
export const EXPORT_BATCH_SIZE = 500
