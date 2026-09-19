import { z } from 'zod'
import { KeyValuesSchema } from './cell.ts'

export const RowKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pk'), values: KeyValuesSchema }),
  z.object({ kind: z.literal('ctid'), value: z.string().min(1) }),
  z.object({ kind: z.literal('all-columns'), values: KeyValuesSchema }),
])
export type RowKey = z.infer<typeof RowKeySchema>
