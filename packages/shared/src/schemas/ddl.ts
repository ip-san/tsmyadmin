import { z } from 'zod'
import { TableKindSchema } from './structure.ts'

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

/** Referential actions accepted by both dialects. */
export const FkActionSchema = z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'])
export type FkAction = z.infer<typeof FkActionSchema>

export const DdlOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createTable'),
    table,
    columns: z.array(ColumnSpecSchema).min(1),
    primaryKey: z.array(z.string().min(1)).default([]),
  }),
  z.object({ op: z.literal('addColumn'), table, column: ColumnSpecSchema, after: z.string().min(1).optional() }),
  z.object({
    op: z.literal('modifyColumn'),
    table,
    name: z.string().min(1),
    column: ColumnSpecSchema,
    /** Current definition; when present PostgreSQL emits only the clauses that actually change. */
    previous: ColumnSpecSchema.optional(),
  }),
  z.object({ op: z.literal('dropColumn'), table, name: z.string().min(1) }),
  z.object({
    op: z.literal('addIndex'),
    table,
    name: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
    unique: z.boolean().default(false),
  }),
  z.object({ op: z.literal('dropIndex'), table, name: z.string().min(1) }),
  z.object({
    op: z.literal('addForeignKey'),
    table,
    name: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
    refTable: z.string().min(1),
    refColumns: z.array(z.string().min(1)).min(1),
    onUpdate: FkActionSchema.optional(),
    onDelete: FkActionSchema.optional(),
  }),
  z.object({ op: z.literal('dropForeignKey'), table, name: z.string().min(1) }),
  /** `kind` selects DROP TABLE / DROP VIEW / DROP MATERIALIZED VIEW (the Operations tab serves views as well). */
  z.object({ op: z.literal('dropTable'), table, kind: TableKindSchema.default('table') }),
  z.object({ op: z.literal('truncateTable'), table }),
  z.object({ op: z.literal('renameTable'), table, newName: z.string().min(1) }),
  /** MySQL: database == schema, so createSchema also creates a database there. */
  z.object({ op: z.literal('createDatabase'), name: z.string().min(1) }),
  z.object({ op: z.literal('dropDatabase'), name: z.string().min(1) }),
  z.object({ op: z.literal('createSchema'), name: z.string().min(1) }),
  /** Copies structure (indexes, keys) and optionally rows into a new table in the same namespace. */
  z.object({
    op: z.literal('copyTable'),
    table,
    newName: z.string().min(1),
    withData: z.boolean().default(true),
    /** Columns to copy when withData (everything except generated columns); omitted = SELECT *. */
    columns: z.array(z.string().min(1)).optional(),
    /** Identity columns of the copy whose sequence must be advanced past the copied values (PostgreSQL). */
    identityColumns: z.array(z.string().min(1)).optional(),
    /** serial columns: the copy gets its own sequence instead of sharing the source's (PostgreSQL). */
    serialColumns: z.array(z.string().min(1)).optional(),
  }),
  /** Table-level options; engine / collation / autoIncrement are MySQL-only (PostgreSQL: UNSUPPORTED). */
  z.object({
    op: z.literal('setTableOptions'),
    table,
    comment: z.string().nullable().optional(),
    engine: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
    collation: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
    /** Digits only (a BIGINT UNSIGNED counter can exceed 2^53, so not a JS number). */
    autoIncrement: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
  }),
  /** Maintenance statements: MySQL ANALYZE / OPTIMIZE / CHECK TABLE, PostgreSQL ANALYZE / VACUUM (FULL). */
  z.object({ op: z.literal('maintainTable'), table, action: z.enum(['analyze', 'optimize', 'check', 'vacuum']) }),
  /** Bulk actions from the database structure page. */
  z.object({ op: z.literal('dropTables'), tables: z.array(table).min(1) }),
  z.object({ op: z.literal('truncateTables'), tables: z.array(table).min(1) }),
  /** MySQL event scheduler (PostgreSQL: UNSUPPORTED). */
  z.object({ op: z.literal('enableEvent'), name: z.string().min(1) }),
  z.object({ op: z.literal('disableEvent'), name: z.string().min(1) }),
  z.object({ op: z.literal('dropEvent'), name: z.string().min(1) }),
])
export type DdlOp = z.infer<typeof DdlOpSchema>
export type DdlOpInput = z.input<typeof DdlOpSchema>
export const DDL_OP_NAMES = DdlOpSchema.options.map((o) => o.shape.op.value)
