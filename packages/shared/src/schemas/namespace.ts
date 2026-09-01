import { z } from 'zod'

/**
 * MySQL: database == schema (schema is unused).
 * PostgreSQL: connection is bound to `database`; `schema` defaults to "public".
 */
export const NamespaceSchema = z.object({
  database: z.string().min(1),
  schema: z.string().min(1).optional(),
})
export type Namespace = z.infer<typeof NamespaceSchema>
