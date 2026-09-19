import { z } from 'zod'
import { GeneratedColumnSchema, TableKindSchema } from './structure.ts'

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
  /**
   * Attributes the column form does not show but a MySQL `MODIFY COLUMN` would silently drop, so they travel
   * with the spec and are re-emitted verbatim. Both are pattern-validated because they render unquoted.
   */
  // Letters, digits, `_`, `.` and `-` (PostgreSQL's `en_US.utf8`); MySQL renders it bare, PostgreSQL quoted.
  collation: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+$/)
    .nullable()
    .default(null),
  onUpdate: z
    .string()
    .regex(/^CURRENT_TIMESTAMP(\(\d\))?$/i)
    .nullable()
    .default(null),
  /**
   * A column-level CHECK to write again (MariaDB drops it on MODIFY COLUMN). Unlike the two above this is an
   * arbitrary expression, so it is only ever carried from `describeTable` — the form never composes one — and
   * the preview shows it before anything runs.
   */
  check: z.string().nullable().default(null),
  /**
   * A generated column: its expression (server-dialect code, shown in the preview before it runs) and whether it
   * is stored. A generated column has no default, identity or ON UPDATE of its own.
   */
  generated: GeneratedColumnSchema.nullable().default(null),
})
export type ColumnSpec = z.infer<typeof ColumnSpecSchema>
export type ColumnSpecInput = z.input<typeof ColumnSpecSchema>

const table = z.string().min(1)

/**
 * An index: its columns, whether it is unique, and — beyond phpMyAdmin's basics — MySQL's FULLTEXT / SPATIAL kinds,
 * the access method (MySQL BTREE / HASH; PostgreSQL btree, hash, gin, gist, brin, spgist) and MySQL prefix
 * lengths per column. Method and kind are closed lists: they render unquoted.
 */
export const IndexKindSchema = z.enum(['index', 'unique', 'fulltext', 'spatial'])
export const IndexMethodSchema = z.enum(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist'])
const IndexShape = {
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  unique: z.boolean().default(false),
  /** Overrides `unique` when given. */
  kind: IndexKindSchema.optional(),
  method: IndexMethodSchema.optional(),
  /** MySQL: index only the first N characters / bytes of a column. */
  lengths: z.record(z.string(), z.number().int().min(1).max(3072)).optional(),
}

/**
 * A type as the server spells it (`INT`, `varchar(20)`, `numeric(10,2)`), rendered as written like a column's
 * data type — the preview shows it before anything runs.
 */
const SqlType = z.string().min(1).max(200)
/** The account an object runs as (MySQL `DEFINER = 'user'@'host'`); rendered as quoted literals. */
const DefinerSchema = z.object({ user: z.string().min(1).max(80), host: z.string().min(1).max(255) })
export type Definer = z.infer<typeof DefinerSchema>
/** `SQL SECURITY` (MySQL) / `SECURITY` (PostgreSQL routines): whose privileges the object runs with. */
const SqlSecuritySchema = z.enum(['DEFINER', 'INVOKER'])
export type SqlSecurity = z.infer<typeof SqlSecuritySchema>
/** What a MySQL routine says about its data access. */
export const DATA_ACCESS = ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'] as const
const DataAccessSchema = z.enum(DATA_ACCESS)
/**
 * A PostgreSQL routine's signature as the catalog prints its arguments (`IN uid integer, OUT n text`): needed to
 * name one of several overloads. Code-like, shown in the preview; a `;` outside quotes is refused.
 */
const RoutineSignature = z
  .string()
  .max(4000)
  .refine((s) => !hasStatementBreak(s) && !/--|\/\*/.test(s), 'A parameter list cannot contain ; or a comment')
/** A body of server-dialect code (SELECT, routine, trigger or event body), shown in the preview before it runs. */
const SqlBody = z.string().trim().min(1).max(1_000_000)
/** `YYYY-MM-DD HH:MM:SS`, as the event scheduler takes a moment. */
const Moment = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

export const RoutineParamSchema = z.object({
  /** OUT / INOUT exist for procedures only (and PostgreSQL functions); the form offers them where they apply. */
  mode: z.enum(['IN', 'OUT', 'INOUT']).default('IN'),
  name: z.string().min(1),
  type: SqlType,
})
export type RoutineParam = z.infer<typeof RoutineParamSchema>

export const EVENT_INTERVAL_UNITS = ['SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const
export const EventScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: Moment }),
  z.object({
    kind: z.literal('every'),
    interval: z.number().int().min(1).max(1_000_000),
    unit: z.enum(EVENT_INTERVAL_UNITS),
    starts: Moment.optional(),
    ends: Moment.optional(),
  }),
])
export type EventSchedule = z.infer<typeof EventScheduleSchema>

/**
 * Partitioning. The method is a closed list (MySQL RANGE / LIST / HASH / KEY; PostgreSQL RANGE / LIST / HASH); the
 * expression (`YEAR(created)`, `(id)`) and each partition's bound are server-dialect code shown in the preview.
 * A bound is the clause after the partition's name as the server spells it: MySQL `VALUES LESS THAN (100)` /
 * `VALUES IN (1, 2)`, PostgreSQL `FOR VALUES FROM (1) TO (100)` / `FOR VALUES IN ('a')` /
 * `FOR VALUES WITH (MODULUS 4, REMAINDER 0)` / `DEFAULT`. MySQL HASH / KEY partitions take none.
 */
export const PartitionMethodSchema = z.enum(['range', 'list', 'hash', 'key'])
export type PartitionMethod = z.infer<typeof PartitionMethodSchema>
/**
 * Whether code has a `;` outside its quoted literals ('…', "…", `…`): a second statement riding along. A partition
 * bound or key never needs one, and the preview would show it only as part of the same statement's text.
 */
export function hasStatementBreak(code: string): boolean {
  return code.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, '').includes(';')
}
const noBreak = (s: string) => !hasStatementBreak(s)
const PartitionCode = z.string().trim().min(1).max(10_000).refine(noBreak, 'A partition key cannot contain ;')
export const PartitionSpecSchema = z.object({
  name: z.string().min(1),
  bound: z.string().trim().max(10_000).refine(noBreak, 'A partition bound cannot contain ;').default(''),
})
export const PartitionByShape = {
  method: PartitionMethodSchema,
  expression: PartitionCode,
}
/** Partition maintenance (MySQL `ALTER TABLE … <action> PARTITION`; PostgreSQL only ANALYZE, on the partition). */
export const PartitionActionSchema = z.enum(['analyze', 'check', 'optimize', 'rebuild', 'repair'])

/** Referential actions accepted by both dialects. */
export const FkActionSchema = z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'])
export type FkAction = z.infer<typeof FkActionSchema>

/** A foreign key as addForeignKey (and a copy's keys) take it. */
const ForeignKeyShape = z.object({
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  refTable: z.string().min(1),
  /** MySQL: a table in another database (PostgreSQL cannot reference across databases). */
  refDatabase: z.string().min(1).optional(),
  /** PostgreSQL: a table in another schema of the same database. */
  refSchema: z.string().min(1).optional(),
  refColumns: z.array(z.string().min(1)).min(1),
  onUpdate: FkActionSchema.optional(),
  onDelete: FkActionSchema.optional(),
})

export const DdlOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('createTable'),
    table,
    columns: z.array(ColumnSpecSchema).min(1),
    primaryKey: z.array(z.string().min(1)).default([]),
    /** Created partitioned (PostgreSQL's only way to get a partitioned table): its partitions are added after. */
    partitionBy: z.object(PartitionByShape).optional(),
  }),
  /** MySQL: partition an existing table (PostgreSQL cannot; it creates a partitioned table instead). */
  z.object({
    op: z.literal('partitionTable'),
    table,
    ...PartitionByShape,
    /** RANGE / LIST: each partition with its bound. HASH / KEY: only `count` is used. */
    partitions: z.array(PartitionSpecSchema).max(1024).default([]),
    count: z.number().int().min(1).max(1024).optional(),
  }),
  z.object({ op: z.literal('addPartition'), table, partition: PartitionSpecSchema }),
  z.object({ op: z.literal('dropPartition'), table, name: z.string().min(1) }),
  z.object({ op: z.literal('truncatePartition'), table, name: z.string().min(1) }),
  /** PostgreSQL: the partition becomes a table of its own, rows kept. */
  z.object({ op: z.literal('detachPartition'), table, name: z.string().min(1) }),
  /** MySQL: back to one table, rows kept. */
  z.object({ op: z.literal('removePartitioning'), table }),
  z.object({ op: z.literal('maintainPartition'), table, name: z.string().min(1), action: PartitionActionSchema }),
  z.object({
    op: z.literal('addColumn'),
    table,
    column: ColumnSpecSchema,
    /** Position (MySQL; PostgreSQL always adds at the end): after this column, or first when `first`. */
    after: z.string().min(1).optional(),
    first: z.boolean().optional(),
    /** A key on the new column, added with it (phpMyAdmin's Index choice in the column form). */
    key: z.enum(['primary', 'unique', 'index']).optional(),
  }),
  z.object({
    op: z.literal('modifyColumn'),
    table,
    name: z.string().min(1),
    column: ColumnSpecSchema,
    /** Current definition; when present PostgreSQL emits only the clauses that actually change. */
    previous: ColumnSpecSchema.optional(),
    /** Moves the column (MySQL only; PostgreSQL cannot reorder columns). */
    after: z.string().min(1).optional(),
    first: z.boolean().optional(),
  }),
  z.object({ op: z.literal('dropColumn'), table, name: z.string().min(1) }),
  /** Several columns in one statement (phpMyAdmin's "Drop" with columns ticked). */
  z.object({ op: z.literal('dropColumns'), table, names: z.array(z.string().min(1)).min(1) }),
  /** Several columns changed at once, in one ALTER on MySQL (phpMyAdmin's "Change" with columns ticked). */
  z.object({
    op: z.literal('modifyColumns'),
    table,
    changes: z
      .array(z.object({ name: z.string().min(1), column: ColumnSpecSchema, previous: ColumnSpecSchema.optional() }))
      .min(1),
  }),
  /** Every column in a new order, with its definition (MySQL rewrites each moved one; PostgreSQL cannot). */
  z.object({ op: z.literal('reorderColumns'), table, columns: z.array(ColumnSpecSchema).min(2) }),
  /** The primary key on these columns, replacing the one there is (named `current` on PostgreSQL). */
  z.object({
    op: z.literal('setPrimaryKey'),
    table,
    columns: z.array(z.string().min(1)).min(1),
    current: z.string().min(1).optional(),
  }),
  z.object({ op: z.literal('addIndex'), table, ...IndexShape }),
  z.object({ op: z.literal('dropIndex'), table, name: z.string().min(1) }),
  z.object({ op: z.literal('renameIndex'), table, name: z.string().min(1), newName: z.string().min(1) }),
  /** An index replaced by a new definition: one ALTER on MySQL, DROP + CREATE on PostgreSQL. */
  z.object({ op: z.literal('alterIndex'), table, name: z.string().min(1), index: z.object(IndexShape) }),
  z.object({
    op: z.literal('addForeignKey'),
    table,
    ...ForeignKeyShape.shape,
  }),
  z.object({ op: z.literal('dropForeignKey'), table, name: z.string().min(1) }),
  /** `kind` selects DROP TABLE / DROP VIEW / DROP MATERIALIZED VIEW (the Operations tab serves views as well). */
  z.object({ op: z.literal('dropTable'), table, kind: TableKindSchema.default('table') }),
  z.object({ op: z.literal('truncateTable'), table }),
  z.object({ op: z.literal('renameTable'), table, newName: z.string().min(1) }),
  /**
   * Moves a table under the same name: to another database on MySQL (RENAME TABLE), to another schema of the same
   * database on PostgreSQL (which cannot move a table between databases).
   */
  z.object({ op: z.literal('moveTable'), table, to: z.string().min(1) }),
  /**
   * phpMyAdmin's "Find and replace" on one text column: every occurrence of `find`, in the rows where replacing
   * changes the value (so the server's comparison rules cannot pick rows the replacement then leaves alone).
   */
  z.object({
    op: z.literal('replaceInColumn'),
    table,
    column: z.string().min(1),
    find: z.string().min(1).max(10_000),
    replace: z.string().max(10_000),
    /** `find` is a regular expression in the server's dialect; back-references in `replace` follow it too. */
    regex: z.boolean().optional(),
  }),
  /**
   * A database's default collation (MySQL; PostgreSQL fixes it when the database is created), and — when
   * `applyToTables` — every table and text column converted to it (PostgreSQL: every text column of the schema).
   * The server fills in the tables, and on PostgreSQL their text columns, when it builds the preview.
   */
  z.object({
    op: z.literal('setDatabaseCollation'),
    name: z.string().min(1),
    collation: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    applyToTables: z.boolean().default(false),
    tables: z.array(table).max(10_000).optional(),
    columns: z.record(z.string(), z.array(z.object({ name: z.string().min(1), dataType: SqlType }))).optional(),
  }),
  /** MySQL: database == schema, so createSchema also creates a database there. */
  z.object({ op: z.literal('createDatabase'), name: z.string().min(1) }),
  z.object({ op: z.literal('dropDatabase'), name: z.string().min(1) }),
  z.object({ op: z.literal('createSchema'), name: z.string().min(1) }),
  /**
   * MySQL has no RENAME DATABASE: a new database and one atomic multi-table RENAME TABLE. The old database is
   * left in place rather than dropped, since DROP DATABASE would also take what could not be moved or seen.
   * `tables` is filled by the preview route from the server, never taken from the client. PostgreSQL renames in
   * place and ignores both fields.
   */
  z.object({
    op: z.literal('renameDatabase'),
    name: z.string().min(1),
    newName: z.string().min(1),
    tables: z.array(z.string().min(1)).optional(),
    collation: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
  }),
  /**
   * PostgreSQL copies the whole database from it as a template (tables, views, routines, sequences, data).
   * MySQL copies base tables only — structure, and rows when `withData` — with foreign keys, views, routines,
   * triggers and events left behind, as phpMyAdmin does.
   */
  z.object({
    op: z.literal('copyDatabase'),
    name: z.string().min(1),
    newName: z.string().min(1),
    withData: z.boolean().default(true),
    /** MySQL: add each table's foreign keys to the copy (which keep pointing at the copy's own tables). */
    foreignKeys: z.boolean().optional(),
    /** MySQL: carry each table's next AUTO_INCREMENT value over (the rows alone would set it from their maximum). */
    autoIncrement: z.boolean().optional(),
    /** MySQL: give the accounts that hold database-level privileges on the source the same on the copy. */
    privileges: z.boolean().optional(),
    /**
     * MySQL: each base table with its insertable columns (generated columns excluded), and — when the options above
     * ask for them — its foreign keys and AUTO_INCREMENT value; `grants` the accounts' privileges. All filled by
     * the preview from the server, never taken from the client.
     */
    tables: z
      .array(
        z.object({
          name: z.string().min(1),
          columns: z.array(z.string().min(1)),
          autoIncrement: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
          foreignKeys: z.array(ForeignKeyShape).optional(),
        })
      )
      .optional(),
    grants: z
      .array(
        z.object({
          user: z.string(),
          host: z.string(),
          privileges: z.array(z.string().regex(/^[A-Z][A-Z ]*$/)),
          grantable: z.boolean(),
        })
      )
      .optional(),
    collation: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
  }),
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
    /** Where the copy goes: another database (MySQL) or schema (PostgreSQL); the source's own by default. */
    toDatabase: z.string().min(1).optional(),
    toSchema: z.string().min(1).optional(),
    /** false: rows only, into a table that already exists under the new name. */
    structure: z.boolean().optional(),
    /** Drop a table of the new name first. */
    dropExisting: z.boolean().optional(),
    /** Foreign keys to add to the copy (LIKE copies none); named for the copy by the caller. */
    foreignKeys: z.array(ForeignKeyShape).max(100).optional(),
  }),
  /**
   * Normalization: moves the columns that depend on `keyColumns` into a new table keyed by them (one row per
   * distinct value), points the original at it with a foreign key, and optionally drops the moved columns. The
   * new table's primary key is added after the rows are copied, so a dependency the data does not follow is
   * refused by the server instead of silently losing values.
   */
  z.object({
    op: z.literal('splitTable'),
    table,
    newName: z.string().min(1),
    keyColumns: z.array(z.string().min(1)).min(1).max(16),
    columns: z.array(z.string().min(1)).min(1).max(200),
    dropMoved: z.boolean().default(false),
  }),
  /**
   * Normalization: a group of numbered columns (`phone1`, `phone2`) becomes rows of a new table — the original's
   * primary key plus one value column — that points back at the original, and the group may then be dropped.
   */
  z.object({
    op: z.literal('moveRepeatingGroup'),
    table,
    newName: z.string().min(1),
    keyColumns: z.array(z.string().min(1)).min(1).max(16),
    columns: z.array(z.string().min(1)).min(2).max(200),
    valueColumn: z.string().min(1),
    dropMoved: z.boolean().default(false),
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
    /** MySQL ROW_FORMAT. */
    rowFormat: z.enum(['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT']).optional(),
    /** MySQL CHECKSUM table option (a live checksum, MyISAM / Aria). */
    checksum: z.boolean().optional(),
  }),
  /**
   * Every text column (and, on MySQL, the table default) to one collation. MySQL converts the table in one
   * statement; PostgreSQL rewrites each listed column with its type and the new collation.
   */
  z.object({
    op: z.literal('convertCollation'),
    table,
    collation: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    /** PostgreSQL: the text columns with their types. */
    columns: z.array(z.object({ name: z.string().min(1), dataType: SqlType })).optional(),
  }),
  /** The rows' physical order: MySQL ALTER TABLE … ORDER BY a column; PostgreSQL CLUSTER on an index. */
  z.object({
    op: z.literal('orderTable'),
    table,
    column: z.string().min(1).optional(),
    desc: z.boolean().optional(),
    index: z.string().min(1).optional(),
  }),
  /** Maintenance statements: MySQL ANALYZE / OPTIMIZE / CHECK TABLE, PostgreSQL ANALYZE / VACUUM (FULL). */
  z.object({
    op: z.literal('maintainTable'),
    table,
    action: z.enum(['analyze', 'optimize', 'check', 'repair', 'vacuum', 'checksum', 'flush']),
  }),
  /** Bulk actions from the database structure page. */
  z.object({ op: z.literal('dropTables'), tables: z.array(table).min(1) }),
  z.object({ op: z.literal('truncateTables'), tables: z.array(table).min(1) }),
  /** Maintenance over several tables at once (MySQL takes the list in one statement; PostgreSQL too). */
  z.object({
    op: z.literal('maintainTables'),
    tables: z.array(table).min(1),
    action: z.enum(['analyze', 'optimize', 'check', 'repair', 'vacuum', 'checksum']),
  }),
  /** Several renames together (phpMyAdmin's "Add / Replace table prefix"). */
  z.object({
    op: z.literal('renameTables'),
    renames: z
      .array(z.object({ from: table, to: table }))
      .min(1)
      .max(1000),
  }),
  /** Several tables copied under their own names into another database (MySQL) or schema (PostgreSQL). */
  z.object({
    op: z.literal('copyTables'),
    tables: z.array(table).min(1),
    toDatabase: z.string().min(1).optional(),
    toSchema: z.string().min(1).optional(),
    withData: z.boolean().default(true),
    /** Per table, what copyTable needs to copy the rows faithfully (filled in by the server's preview). */
    details: z
      .record(
        z.string(),
        z.object({
          columns: z.array(z.string().min(1)).optional(),
          identityColumns: z.array(z.string().min(1)).optional(),
          serialColumns: z.array(z.string().min(1)).optional(),
        })
      )
      .optional(),
  }),
  /** A view over a SELECT; `orReplace` swaps the definition of one that exists. */
  z.object({
    op: z.literal('createView'),
    name: z.string().min(1),
    select: SqlBody,
    orReplace: z.boolean().default(false),
    /** Names for the view's columns (otherwise the SELECT's own). */
    columns: z.array(z.string().min(1)).max(1000).optional(),
    /** `WITH [CASCADED | LOCAL] CHECK OPTION`: an INSERT / UPDATE through the view must satisfy its WHERE. */
    checkOption: z.enum(['CASCADED', 'LOCAL']).optional(),
    /** MySQL only. */
    algorithm: z.enum(['UNDEFINED', 'MERGE', 'TEMPTABLE']).optional(),
    definer: DefinerSchema.optional(),
    sqlSecurity: SqlSecuritySchema.optional(),
  }),
  /**
   * A stored procedure or function. The body is the dialect's own: MySQL a statement or BEGIN … END block,
   * PostgreSQL the code of the function in `language` (plpgsql: a BEGIN … END block).
   */
  z.object({
    op: z.literal('createRoutine'),
    kind: z.enum(['procedure', 'function']),
    name: z.string().min(1),
    params: z.array(RoutineParamSchema).default([]),
    /** Functions only. */
    returns: SqlType.optional(),
    body: SqlBody,
    /** PostgreSQL only (MySQL routines are SQL): a language name. */
    language: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .default('plpgsql'),
    /** MySQL functions under binary logging must declare it. */
    deterministic: z.boolean().default(false),
    comment: z.string().max(1024).optional(),
    /** MySQL only. */
    definer: DefinerSchema.optional(),
    /** MySQL `SQL SECURITY`, PostgreSQL `SECURITY`. */
    sqlSecurity: SqlSecuritySchema.optional(),
    /** MySQL only. */
    dataAccess: DataAccessSchema.optional(),
  }),
  /** Drops a procedure or function; PostgreSQL names it by its parameter list (overloads). */
  z.object({
    op: z.literal('dropRoutine'),
    kind: z.enum(['procedure', 'function']),
    name: z.string().min(1),
    parameters: RoutineSignature.optional(),
  }),
  /** Changes what can change without rewriting the body: security, data access (MySQL) and the comment. */
  z.object({
    op: z.literal('alterRoutine'),
    kind: z.enum(['procedure', 'function']),
    name: z.string().min(1),
    parameters: RoutineSignature.optional(),
    sqlSecurity: SqlSecuritySchema.optional(),
    dataAccess: DataAccessSchema.optional(),
    comment: z.string().max(1024).optional(),
  }),
  z.object({ op: z.literal('dropTrigger'), name: z.string().min(1), table }),
  /**
   * A row-level trigger. MySQL: the body is a statement or BEGIN … END block. PostgreSQL: a PL/pgSQL block that
   * returns the row (`BEGIN … RETURN NEW; END`), put in a trigger function named after the trigger.
   */
  z.object({
    op: z.literal('createTrigger'),
    name: z.string().min(1),
    table,
    timing: z.enum(['BEFORE', 'AFTER']),
    event: z.enum(['INSERT', 'UPDATE', 'DELETE']),
    body: SqlBody,
    /** MySQL only. */
    definer: DefinerSchema.optional(),
  }),
  /** MySQL event scheduler (PostgreSQL: UNSUPPORTED). */
  z.object({
    op: z.literal('createEvent'),
    name: z.string().min(1),
    schedule: EventScheduleSchema,
    body: SqlBody,
    enabled: z.boolean().default(true),
    comment: z.string().max(1024).optional(),
    /** Keep the event after it has run (a one-time AT event is otherwise dropped). */
    preserve: z.boolean().optional(),
    definer: DefinerSchema.optional(),
  }),
  z.object({ op: z.literal('enableEvent'), name: z.string().min(1) }),
  z.object({ op: z.literal('disableEvent'), name: z.string().min(1) }),
  z.object({ op: z.literal('dropEvent'), name: z.string().min(1) }),
])
export type DdlOp = z.infer<typeof DdlOpSchema>
export type DdlOpInput = z.input<typeof DdlOpSchema>
export const DDL_OP_NAMES = DdlOpSchema.options.map((o) => o.shape.op.value)
