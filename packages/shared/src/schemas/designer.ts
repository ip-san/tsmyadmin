import { z } from 'zod'

const PointSchema = z.object({ x: z.number(), y: z.number() })

/**
 * phpMyAdmin's Designer "page": where each table's box sits on the diagram of one database (and schema), kept under
 * a name so a large database can have several views of it. Restored into the diagram, not applied to the database.
 */
export const DesignerPageBodySchema = z.object({
  database: z.string().min(1).max(256),
  schema: z.string().min(1).max(256).optional(),
  positions: z.record(z.string().max(256), PointSchema).refine((p) => Object.keys(p).length <= 5000),
  /** Whether every column of a table is listed in its box, not only the ones a key uses. */
  allColumns: z.boolean().default(false),
})
export type DesignerPageBody = z.infer<typeof DesignerPageBodySchema>
export const DesignerPageSchema = DesignerPageBodySchema.extend({
  id: z.string().default(''),
  name: z.string().min(1).max(200),
  at: z.number(),
})
export type DesignerPage = z.infer<typeof DesignerPageSchema>
export const SaveDesignerPageRequestSchema = DesignerPageBodySchema.extend({ name: z.string().min(1).max(200) })
export type SaveDesignerPageRequest = z.infer<typeof SaveDesignerPageRequestSchema>
export const designerPageKey = (p: { database: string; schema?: string | undefined; name: string }) =>
  JSON.stringify([p.database, p.schema ?? '', p.name])
