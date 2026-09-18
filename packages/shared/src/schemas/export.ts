import { z } from 'zod'
import { FlagSchema } from './common.ts'

export const ExportFormatSchema = z.enum(['sql', 'csv', 'json', 'xml', 'yaml', 'markdown'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

/** CSV field separators: a semicolon is what Excel expects where the decimal separator is a comma. */
export const CSV_DELIMITERS = { comma: ',', semicolon: ';', tab: '\t' } as const
export const CsvDelimiterSchema = z.enum(['comma', 'semicolon', 'tab'])
export type CsvDelimiter = z.infer<typeof CsvDelimiterSchema>

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
  /**
   * CSV: prefix values starting with `= + - @` with an apostrophe so a spreadsheet does not run them as
   * formulas. Off by default because it changes the value, which would break the round trip back through import.
   */
  csvSafe: FlagSchema.default('0'),
  csvDelimiter: CsvDelimiterSchema.default('comma'),
  /** SQL: include stored routines, triggers and events (triggers of the requested tables when tables are named). */
  routines: FlagSchema.default('1'),
  /** SQL (MySQL): drop `DEFINER=...` clauses so the dump restores under another account. */
  stripDefiner: FlagSchema.default('0'),
})
export type ExportQuery = z.infer<typeof ExportQuerySchema>

/**
 * The same choices as ExportQuerySchema, as the form holds them: booleans rather than the `'0'`/`'1'` strings a
 * query string carries. A saved template stores these, and the download URL is built from them.
 */
export const ExportOptionsSchema = z.object({
  format: ExportFormatSchema.default('sql'),
  structure: z.boolean().default(true),
  dropTable: z.boolean().default(true),
  data: z.boolean().default(true),
  bom: z.boolean().default(true),
  csvSafe: z.boolean().default(false),
  csvDelimiter: CsvDelimiterSchema.default('comma'),
  routines: z.boolean().default(true),
  stripDefiner: z.boolean().default(false),
})
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

/** As many tables as the URL can carry; a longer selection is refused by the form before it is saved. */
export const EXPORT_TEMPLATE_MAX_TABLES = 500
/** Longest identifier a template may name: 64 bytes is the server limit, with room for multi-byte names. */
const IDENTIFIER_MAX = 256

/**
 * A named set of export choices. It belongs to one database (and schema on PostgreSQL) because the table names
 * do; the export page shows only the templates of the namespace being looked at. An empty `tables` means the
 * whole database, exactly as it does in the form.
 */
export const ExportTemplateBodySchema = z.object({
  // Bounded like the statement a bookmark carries: identifiers are far shorter than this on either server, and
  // without a cap one template could hold as much text as the whole per-account allowance.
  database: z.string().min(1).max(IDENTIFIER_MAX),
  schema: z.string().min(1).max(IDENTIFIER_MAX).optional(),
  tables: z.array(z.string().min(1).max(IDENTIFIER_MAX)).max(EXPORT_TEMPLATE_MAX_TABLES).default([]),
  options: ExportOptionsSchema,
})
export type ExportTemplateBody = z.infer<typeof ExportTemplateBodySchema>

/** `id` is assigned by the server; a browser-side list leaves it empty. */
export const ExportTemplateSchema = ExportTemplateBodySchema.extend({
  id: z.string().default(''),
  name: z.string().min(1).max(200),
  at: z.number(),
})
export type ExportTemplate = z.infer<typeof ExportTemplateSchema>

export const SaveExportTemplateRequestSchema = ExportTemplateBodySchema.extend({
  name: z.string().min(1).max(200),
})
export type SaveExportTemplateRequest = z.infer<typeof SaveExportTemplateRequestSchema>

/**
 * How a template is addressed in the store, which replaces by name: the name alone would make one saved for
 * another database of the same server replace it, since the store cannot read the namespace inside the payload.
 */
export function exportTemplateKey(template: { database: string; schema?: string | undefined; name: string }): string {
  return JSON.stringify([template.database, template.schema ?? '', template.name])
}
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
