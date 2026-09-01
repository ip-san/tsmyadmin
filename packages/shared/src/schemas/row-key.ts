import { z } from 'zod'
import { RowValuesSchema } from './cell.ts'

export const RowKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pk'), values: RowValuesSchema }),
  z.object({ kind: z.literal('ctid'), value: z.string().min(1) }),
  z.object({ kind: z.literal('all-columns'), values: RowValuesSchema }),
])
export type RowKey = z.infer<typeof RowKeySchema>
