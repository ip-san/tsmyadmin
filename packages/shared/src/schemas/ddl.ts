import { z } from 'zod'

export const ColumnDefaultSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('literal'), value: z.string() }),
    z.object({ kind: z.literal('expression'), sql: z.string().min(1) }),
  ])
  .nullable()
export type ColumnDefault = z.infer<typeof ColumnDefaultSchema>

export const ColumnSpecSchema = z.object({
  name: z.string().min(1),
  dataType: z.string().min(1),
  nullable: z.boolean(),
  default: ColumnDefaultSchema,
  autoIncrement: z.boolean().default(false),
  comment: z.string().nullable().default(null),
})
export type ColumnSpec = z.infer<typeof ColumnSpecSchema>
export type ColumnSpecInput = z.input<typeof ColumnSpecSchema>

const table = z.string().min(1)

export const DdlOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createTable'),
    table,
    columns: z.array(ColumnSpecSchema).min(1),
    primaryKey: z.array(z.string()).default([]),
  }),
  z.object({ op: z.literal('addColumn'), table, column: ColumnSpecSchema, after: z.string().optional() }),
  z.object({ op: z.literal('modifyColumn'), table, name: z.string().min(1), column: ColumnSpecSchema }),
  z.object({ op: z.literal('dropColumn'), table, name: z.string().min(1) }),
  z.object({
    op: z.literal('addIndex'),
    table,
    name: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
    unique: z.boolean().default(false),
  }),
  z.object({ op: z.literal('dropIndex'), table, name: z.string().min(1) }),
  z.object({ op: z.literal('dropTable'), table }),
  z.object({ op: z.literal('truncateTable'), table }),
  z.object({ op: z.literal('renameTable'), table, newName: z.string().min(1) }),
  /** MySQL: database == schema, so createSchema also creates a database there. */
  z.object({ op: z.literal('createDatabase'), name: z.string().min(1) }),
  z.object({ op: z.literal('dropDatabase'), name: z.string().min(1) }),
  z.object({ op: z.literal('createSchema'), name: z.string().min(1) }),
])
export type DdlOp = z.infer<typeof DdlOpSchema>
export type DdlOpInput = z.input<typeof DdlOpSchema>
export const DDL_OP_NAMES = DdlOpSchema.options.map((o) => o.shape.op.value)
