import { z } from 'zod'

const PointSchema = z.object({ x: z.number(), y: z.number() })

/** How the diagram is drawn (phpMyAdmin's Designer toolbar): kept with a saved page and in this browser. */
export const DesignerViewSchema = z.object({
  /** Boxes show only the table's name. */
  compact: z.boolean().default(false),
  /** Boxes snap to a grid while they are moved. */
  snap: z.boolean().default(false),
  /** Each box is as wide as its longest table or column name (up to a limit), not a fixed width. */
  fitWidth: z.boolean().default(false),
  /** The lines: curved, straight, or straight segments at right angles. */
  lineStyle: z.enum(['curve', 'straight', 'polyline']).default('curve'),
  /** A label (the key's columns) at the middle of each line. */
  lineLabels: z.boolean().default(false),
  /** false: the lines are left out (only the boxes). */
  showLines: z.boolean().default(true),
})
export type DesignerView = z.infer<typeof DesignerViewSchema>

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
  /** The drawing options of the page (a page saved before they existed has none). */
  view: DesignerViewSchema.optional(),
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
