import { z } from 'zod'
import { NamespaceSchema } from './namespace.ts'

/** 'sequence' is a MariaDB SEQUENCE object (listed with the tables; read-only, dumped as CREATE SEQUENCE). */
export const TableKindSchema = z.enum(['table', 'view', 'materialized_view', 'sequence'])
export type TableKind = z.infer<typeof TableKindSchema>
/** Views and materialized views: no row identity, read-only in the UI. */
export const isViewKind = (kind: TableKind): boolean => kind !== 'table'

/** Server-level database list entry; sizes are catalog figures (null when the account cannot see them). */
export const DatabaseInfoSchema = z.object({
  name: z.string(),
  /** Data + index bytes (MySQL information_schema.TABLES, PostgreSQL pg_database_size). */
  sizeBytes: z.number().nullable(),
  /** Tables and views (MySQL only; PostgreSQL counts need a connection per database). */
  tableCount: z.number().nullable(),
})
export type DatabaseInfo = z.infer<typeof DatabaseInfoSchema>

export const TableInfoSchema = z.object({
  name: z.string(),
  kind: TableKindSchema,
  rowEstimate: z.number().nullable(),
  engine: z.string().nullable(),
  comment: z.string().nullable(),
  /** Data + index bytes (DATA_LENGTH + INDEX_LENGTH / pg_total_relation_size); null for views. */
  sizeBytes: z.number().nullable(),
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
  /** Partial-index WHERE clause (PostgreSQL); null for full indexes and on MySQL. */
  predicate: z.string().nullable(),
  /** Complete CREATE INDEX statement as the server prints it (PostgreSQL: access method, direction, opclass, INCLUDE); null on MySQL. */
  definition: z.string().nullable(),
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

export const ReferencingKeyDefSchema = z.object({
  name: z.string(),
  /** Table holding the foreign key. */
  fromNamespace: NamespaceSchema,
  fromTable: z.string(),
  fromColumns: z.array(z.string()),
  /** Columns of this table that are referenced. */
  columns: z.array(z.string()),
})
export type ReferencingKeyDef = z.infer<typeof ReferencingKeyDefSchema>

export const TableSchemaSchema = z.object({
  name: z.string(),
  kind: TableKindSchema,
  comment: z.string().nullable(),
  engine: z.string().nullable(),
  /** Catalog row-count estimate (TABLE_ROWS / reltuples); null for views or before the table was analysed. */
  rowEstimate: z.number().nullable(),
  /** Partitioned table (PostgreSQL relkind 'p'): rows live only in the partitions. */
  partitioned: z.boolean(),
  /** Inheritance parent (PostgreSQL): reads through it include child rows, so ctid cannot identify a row. */
  hasChildren: z.boolean(),
  /** Table collation (MySQL); null on PostgreSQL. */
  collation: z.string().nullable(),
  /** Next AUTO_INCREMENT value as digits (MySQL); null when none. */
  autoIncrement: z.string().nullable(),
  columns: z.array(ColumnDefSchema),
  primaryKey: z.array(z.string()),
  indexes: z.array(IndexDefSchema),
  foreignKeys: z.array(ForeignKeyDefSchema),
  /** Foreign keys in other tables that point at this table (reverse references). */
  referencedBy: z.array(ReferencingKeyDefSchema),
})
export type TableSchema = z.infer<typeof TableSchemaSchema>
