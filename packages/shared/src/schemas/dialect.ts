import { z } from 'zod'

export const DialectSchema = z.enum(['mysql', 'postgres'])
export type Dialect = z.infer<typeof DialectSchema>
