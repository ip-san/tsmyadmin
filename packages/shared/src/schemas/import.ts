import { z } from 'zod'
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
})
export type ImportForm = z.infer<typeof ImportFormSchema>

export const ImportErrorSchema = z.object({ sql: z.string(), message: z.string(), code: z.string().optional() })

export const ImportResultSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('sql'),
    statements: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    /** First errors only (capped). */
    errors: z.array(ImportErrorSchema),
    durationMs: z.number(),
  }),
  z.object({
    format: z.literal('csv'),
    table: z.string(),
    columns: z.array(z.string()),
    inserted: z.number(),
    durationMs: z.number(),
  }),
])
export type ImportResult = z.infer<typeof ImportResultSchema>
