import { z } from 'zod'
import { ApiErrorSchema } from './api.ts'
import { FlagSchema } from './common.ts'

export const ImportFormatSchema = z.enum(['sql', 'csv'])
export type ImportFormat = z.infer<typeof ImportFormatSchema>

export const IMPORT_MAX_BYTES = 64 * 1024 * 1024

/** multipart/form-data fields of POST /databases/:db/import. */
export const ImportFormSchema = z.object({
  file: z.instanceof(File),
  format: ImportFormatSchema,
  schema: z.string().min(1).optional(),
  /** csv: target table */
  table: z.string().min(1).optional(),
  /** csv: first row holds column names (else positional, table column order) */
  header: FlagSchema.default('1'),
  /** csv: field value that means NULL */
  nullMarker: z.string().default('\\N'),
  /** One character that is not the quote or a line break (those are structural to the parser). */
  delimiter: z
    .string()
    .length(1)
    .refine((d) => !'"\r\n'.includes(d), 'delimiter cannot be a quote or a line break')
    .default(','),
  /** sql: stop at the first failing statement */
  stopOnError: FlagSchema.default('1'),
  /** sql: disable foreign key checks for the run (mysqldump --compact files, tables in the wrong order) */
  ignoreForeignKeys: FlagSchema.default('0'),
  /** sql: run the whole script in one transaction and roll everything back on the first error */
  singleTransaction: FlagSchema.default('0'),
  /**
   * Client-generated id so the run can be stopped with POST /sql/cancel while the stream stays open: the
   * client then still receives the result (what ran, what was rolled back). Aborting the upload also cancels.
   */
  queryId: z.string().uuid().optional(),
})
export type ImportForm = z.infer<typeof ImportFormSchema>

export const ImportErrorSchema = z.object({
  sql: z.string(),
  message: z.string(),
  code: z.string().optional(),
  /** 1-based line of the file where the statement starts. */
  line: z.number().int().min(1).optional(),
  /** 0-based index of the statement in the file. */
  index: z.number().int().min(0).optional(),
})

/** Things worth telling the user after a run that reported no error of its own. */
export const ImportWarningSchema = z.enum([
  /** The script switched databases (USE / \connect) or created / dropped one: rows may have gone elsewhere. */
  'CHANGED_DATABASE',
  /** A transaction the script opened was still open at the end and has been rolled back. */
  'ROLLED_BACK',
  /** The whole run was rolled back (single-transaction mode after an error). */
  'ALL_ROLLED_BACK',
  /** Single-transaction mode after an error, but the script had committed on its own (COMMIT, MySQL DDL) before it. */
  'PARTIALLY_ROLLED_BACK',
])
export type ImportWarning = z.infer<typeof ImportWarningSchema>

export const ImportResultSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('sql'),
    /** Statements found in the file. */
    total: z.number(),
    /** Statements executed (the rest were skipped after an error with stop-on-error). */
    statements: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    /** First errors only (capped). */
    errors: z.array(ImportErrorSchema),
    warnings: z.array(ImportWarningSchema),
    durationMs: z.number(),
  }),
  z.object({
    format: z.literal('csv'),
    table: z.string(),
    columns: z.array(z.string()),
    /** Header columns the server computes itself (generated), left out of the INSERT. */
    skippedColumns: z.array(z.string()),
    inserted: z.number(),
    durationMs: z.number(),
  }),
])
export type ImportResult = z.infer<typeof ImportResultSchema>

/** NDJSON events of POST /databases/:db/import: progress while it runs, then the result or a fatal error. */
export const ImportEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), done: z.number().int().min(0), total: z.number().int().min(0) }),
  z.object({ type: z.literal('result'), result: ImportResultSchema }),
  z.object({ type: z.literal('fatal'), error: z.lazy(() => ApiErrorSchema) }),
])
export type ImportEvent = z.infer<typeof ImportEventSchema>

/**
 * Input problems the user can fix, identified for localisation; `params` fill the message. Sent as the
 * `reason` / `params` of a 400 VALIDATION error.
 */
export const ImportReasonSchema = z.enum([
  'INVALID_ENCODING',
  'WRONG_DIALECT',
  'NO_STATEMENTS',
  'CSV_NO_TABLE',
  'CSV_EMPTY',
  'CSV_UNKNOWN_COLUMNS',
  /** A header name matches several table columns differing only in case (params: columns). */
  'CSV_AMBIGUOUS_COLUMNS',
  /** A header names the same column twice (params: columns). */
  'CSV_DUPLICATE_COLUMNS',
  'CSV_NO_COLUMNS',
  'CSV_FIELD_COUNT',
  'CSV_BINARY',
  'CSV_UNTERMINATED_QUOTE',
  'CSV_ROW_FAILED',
  'CSV_ROWS_FAILED',
  /** DDL / account previews: an identifier longer than the server allows (params: name, max). */
  'IDENTIFIER_TOO_LONG',
  /** An import option's SET statement was refused by the server (params: option, message). */
  'OPTION_FAILED',
])
export type ImportReason = z.infer<typeof ImportReasonSchema>
