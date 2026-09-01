import { z } from 'zod'
import { NamespaceSchema } from './namespace.ts'

export const TableKindSchema = z.enum(['table', 'view'])
export type TableKind = z.infer<typeof TableKindSchema>

export const TableInfoSchema = z.object({
  name: z.string(),
  kind: TableKindSchema,
  rowEstimate: z.number().nullable(),
  engine: z.string().nullable(),
  comment: z.string().nullable(),
})
export type TableInfo = z.infer<typeof TableInfoSchema>

export const ColumnDefSchema = z.object({
  name: z.string(),
  /** Full type as the dialect prints it, e.g. "varchar(100)", "numeric(20,6)", "int[]". */
  dataType: z.string(),
  nullable: z.boolean(),
  /** Default expression as stored by the catalog, null when none. */
  default: z.string().nullable(),
  /** e.g. "auto_increment", "identity", "on update CURRENT_TIMESTAMP". */
  extra: z.string(),
  comment: z.string().nullable(),
  collation: z.string().nullable(),
})
export type ColumnDef = z.infer<typeof ColumnDefSchema>

export const IndexDefSchema = z.object({
  name: z.string(),
  unique: z.boolean(),
  primary: z.boolean(),
  columns: z.array(z.string()),
  type: z.string().nullable(),
})
export type IndexDef = z.infer<typeof IndexDefSchema>

export const ForeignKeyDefSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  refNamespace: NamespaceSchema,
  refTable: z.string(),
  refColumns: z.array(z.string()),
  onUpdate: z.string().nullable(),
  onDelete: z.string().nullable(),
})
export type ForeignKeyDef = z.infer<typeof ForeignKeyDefSchema>

export const TableSchemaSchema = z.object({
  name: z.string(),
  kind: TableKindSchema,
  comment: z.string().nullable(),
  engine: z.string().nullable(),
  columns: z.array(ColumnDefSchema),
  primaryKey: z.array(z.string()),
  indexes: z.array(IndexDefSchema),
  foreignKeys: z.array(ForeignKeyDefSchema),
})
export type TableSchema = z.infer<typeof TableSchemaSchema>
