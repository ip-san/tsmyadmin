import { z } from 'zod'
import { FlagSchema } from './common.ts'

export const ExportFormatSchema = z.enum([
  'sql',
  'csv',
  'csvExcel',
  'json',
  'xml',
  'yaml',
  'markdown',
  'latex',
  'texy',
  'mediawiki',
  'html',
  'ods',
  'odt',
  'docx',
])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

/** Formats that hold one table's rows only (a table per file): the CSV family. */
export const SINGLE_TABLE_FORMATS: readonly ExportFormat[] = ['csv', 'csvExcel']
/** Formats that are binary (ZIP-based): no character set applies to them. */
export const BINARY_FORMATS: readonly ExportFormat[] = ['ods', 'odt', 'docx']

/** How the file is compressed: as one .gz, or as a .zip (which is what one file per table also makes). */
export const ExportCompressionSchema = z.enum(['none', 'gzip', 'zip'])
export type ExportCompression = z.infer<typeof ExportCompressionSchema>

/** How SQL dumps write the rows. */
export const ExportStatementSchema = z.enum(['insert', 'update', 'replace'])
export type ExportStatement = z.infer<typeof ExportStatementSchema>

/** Character sets a text export can be written in (UTF-8 is the default; the rest are for older programs). */
export const EXPORT_CHARSETS = [
  'utf-8',
  'cp932',
  'euc-jp',
  'iso-8859-1',
  'windows-1252',
  'gbk',
  'big5',
  'euc-kr',
] as const
export const ExportCharsetSchema = z.enum(EXPORT_CHARSETS)
export type ExportCharset = z.infer<typeof ExportCharsetSchema>

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
  compress: ExportCompressionSchema.default('none'),
  /** One file per table, in a ZIP. */
  filePerTable: FlagSchema.default('0'),
  /** File name template: `@DATABASE@`, `@TABLE@`, `@SERVER@` and the date parts `%Y %m %d %H %M %S`. */
  filename: z.string().max(200).optional(),
  charset: ExportCharsetSchema.default('utf-8'),
  /** SQL: what the data is written as. `update` and `replace` need a primary key on every table. */
  statement: ExportStatementSchema.default('insert'),
  /** SQL: name the columns in every INSERT. */
  columnNames: FlagSchema.default('1'),
  /** SQL: several rows to an INSERT (false: one statement per row). */
  extended: FlagSchema.default('1'),
  /** SQL: the most bytes of one extended INSERT; 0 is no limit beyond a batch of rows. */
  maxQuery: z.coerce.number().int().min(0).max(100_000_000).default(0),
  /** SQL: INSERT IGNORE (MySQL) / ON CONFLICT DO NOTHING (PostgreSQL). */
  ignore: FlagSchema.default('0'),
  /** SQL: times as UTC, with the session set to UTC around them. */
  utc: FlagSchema.default('0'),
  /** SQL: the whole dump in one transaction. */
  transaction: FlagSchema.default('0'),
  /** SQL: views become tables holding their rows. */
  viewsAsTables: FlagSchema.default('0'),
  /** SQL: CREATE DATABASE IF NOT EXISTS + USE (PostgreSQL: CREATE SCHEMA + search_path). */
  createDatabase: FlagSchema.default('0'),
  /** SQL: CREATE TABLE IF NOT EXISTS. */
  ifNotExists: FlagSchema.default('0'),
  /** SQL: comment lines and section headings. */
  comments: FlagSchema.default('1'),
  /** SQL (MySQL): LOCK TABLES … WRITE around each table's rows. */
  lockTables: FlagSchema.default('0'),
  /** Every format: only these rows of each table (offset, then a limit; 0 is no limit). */
  rowOffset: z.coerce.number().int().min(0).max(1_000_000_000_000).default(0),
  rowLimit: z.coerce.number().int().min(0).max(1_000_000_000_000).default(0),
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
  compress: ExportCompressionSchema.default('none'),
  filePerTable: z.boolean().default(false),
  filename: z.string().max(200).default(''),
  charset: ExportCharsetSchema.default('utf-8'),
  statement: ExportStatementSchema.default('insert'),
  columnNames: z.boolean().default(true),
  extended: z.boolean().default(true),
  maxQuery: z.number().int().min(0).default(0),
  ignore: z.boolean().default(false),
  utc: z.boolean().default(false),
  transaction: z.boolean().default(false),
  viewsAsTables: z.boolean().default(false),
  createDatabase: z.boolean().default(false),
  ifNotExists: z.boolean().default(false),
  comments: z.boolean().default(true),
  lockTables: z.boolean().default(false),
  rowOffset: z.number().int().min(0).default(0),
  rowLimit: z.number().int().min(0).default(0),
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

/**
 * Query of GET /server/export: several databases (MySQL) or schemas of the connected database (PostgreSQL) as one SQL
 * dump, each written with its own CREATE DATABASE / CREATE SCHEMA. `filePerTable` here means one file per target.
 */
export const ServerExportQuerySchema = ExportQuerySchema.omit({ schema: true, tables: true, format: true }).extend({
  /** Comma-separated database (or schema) names, percent-encoded like a table list. */
  targets: z.string().min(1),
})
export type ServerExportQuery = z.infer<typeof ServerExportQuerySchema>

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
