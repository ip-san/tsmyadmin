import { z } from 'zod'
import { NamespaceSchema } from './namespace.ts'

/** 'sequence' is a MariaDB SEQUENCE or a standalone PostgreSQL sequence (listed with the tables; read-only, dumped as CREATE SEQUENCE). */
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
  /** Inheritance parents in the same schema (PostgreSQL); [] elsewhere. Lets a dump order tables without describing each. */
  inherits: z.array(z.string()).default([]),
  /** For a PostgreSQL sequence OWNED BY a column: that column (the sequence goes wherever the table goes). */
  ownedBy: z.object({ table: z.string(), column: z.string() }).optional(),
})
export type TableInfo = z.infer<typeof TableInfoSchema>

export const ColumnDefSchema = z.object({
  name: z.string(),
  /** Full type as the dialect prints it, e.g. "varchar(100)", "numeric(20,6)", "int[]". */
  dataType: z.string(),
  nullable: z.boolean(),
  /** Default as stored by the catalog, null when none. Ready to replay: quoting and escaping are undone. */
  default: z.string().nullable(),
  /**
   * Whether `default` is an expression rather than a literal value. The dialects report this differently
   * (MySQL 8 flags it in `extra`, MariaDB quotes literals instead, PostgreSQL always stores an expression),
   * so the answer is normalised here rather than sniffed from the text by every consumer.
   */
  defaultIsExpression: z.boolean(),
  /** e.g. "auto_increment", "identity", "on update CURRENT_TIMESTAMP". */
  extra: z.string(),
  comment: z.string().nullable(),
  collation: z.string().nullable(),
})
export type ColumnDef = z.infer<typeof ColumnDefSchema>

/**
 * Columns whose values the server computes, so they can be neither inserted nor written back: MySQL
 * `VIRTUAL GENERATED` / `STORED GENERATED`, PostgreSQL `generated stored`. MySQL's `DEFAULT_GENERATED`
 * (an expression default such as CURRENT_TIMESTAMP) is an ordinary column and is not matched.
 */
export function isGeneratedColumn(extra: string): boolean {
  return /^(?:(?:VIRTUAL|STORED) )?GENERATED\b/i.test(extra)
}

/** MySQL prints `on update CURRENT_TIMESTAMP[(n)]` in `extra`; the clause is invisible to the column form. */
export function onUpdateExpression(extra: string): string | null {
  return /\bon update (CURRENT_TIMESTAMP(?:\(\d\))?)/i.exec(extra)?.[1]?.toUpperCase() ?? null
}

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
  /** Inheritance parents in the same schema (PostgreSQL `INHERITS`): a dump creates them first. */
  inherits: z.array(z.string()).default([]),
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
