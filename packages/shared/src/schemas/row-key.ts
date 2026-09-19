import { z } from 'zod'
import { KeyValuesSchema } from './cell.ts'

export const RowKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pk'), values: KeyValuesSchema }),
  z.object({ kind: z.literal('ctid'), value: z.string().min(1) }),
  z.object({ kind: z.literal('all-columns'), values: KeyValuesSchema }),
])
export type RowKey = z.infer<typeof RowKeySchema>

/** One value of one row, to download whole: the row's key travels as JSON in the query string (a link, not a form). */
export const CellQuerySchema = z.object({
  schema: z.string().min(1).optional(),
  column: z.string().min(1),
  key: z.string().min(2).max(100_000),
})
export type CellQuery = z.infer<typeof CellQuerySchema>

/** The key of a CellQuery; null when it is not JSON or not a RowKey. */
export function parseCellKey(raw: string): RowKey | null {
  try {
    const parsed = RowKeySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
