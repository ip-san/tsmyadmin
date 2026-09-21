import type { DdlOp, Dialect, Namespace } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'
import { quoteIdent, quoteTable } from './quote.ts'

type AddForeignKey = Extract<DdlOp, { op: 'addForeignKey' }>

const DROP_KIND_ORDER = ['view', 'materialized_view', 'table', 'sequence'] as const
/** The objects of a `dropObjects` op in the order they can go: views before the tables they read, sequences last. */
export function dropOrder(objects: Extract<DdlOp, { op: 'dropObjects' }>['objects']) {
  return DROP_KIND_ORDER.flatMap((kind) => objects.filter((o) => o.kind === kind))
}

/** `ALTER TABLE t ADD CONSTRAINT name FOREIGN KEY (...) REFERENCES ref (...) [ON UPDATE x] [ON DELETE y]` — same on both dialects. */
export function addForeignKeySql(dialect: Dialect, ns: Namespace, op: AddForeignKey): string {
  const id = (s: string) => quoteIdent(dialect, s)
  if (dialect === 'postgres' && op.refDatabase && op.refDatabase !== ns.database)
    throw new AdapterError('UNSUPPORTED', 'PostgreSQL cannot reference a table in another database')
  // The referenced table's namespace: another database (MySQL) or schema (PostgreSQL), else the table's own.
  const refNs: Namespace =
    dialect === 'mysql'
      ? { database: op.refDatabase ?? ns.database }
      : { database: ns.database, ...((op.refSchema ?? ns.schema) ? { schema: op.refSchema ?? ns.schema } : {}) }
  const actions = [op.onUpdate ? ` ON UPDATE ${op.onUpdate}` : '', op.onDelete ? ` ON DELETE ${op.onDelete}` : '']
  return `ALTER TABLE ${quoteTable(dialect, ns, op.table)} ADD CONSTRAINT ${id(op.name)} FOREIGN KEY (${op.columns
    .map(id)
    .join(
      ', '
    )}) REFERENCES ${quoteTable(dialect, refNs, op.refTable)} (${op.refColumns.map(id).join(', ')})${actions.join('')}`
}

/** An index's definition, as addIndex and alterIndex carry it. */
type IndexSpec = Omit<Extract<DdlOp, { op: 'addIndex' }>, 'op'>

function kindOf(i: IndexSpec): 'index' | 'unique' | 'fulltext' | 'spatial' {
  return i.kind ?? (i.unique ? 'unique' : 'index')
}

/**
 * The kind, method and column list of an index for a dialect. MySQL: FULLTEXT / SPATIAL, BTREE / HASH (not with
 * FULLTEXT or SPATIAL) and prefix lengths. PostgreSQL: any access method, and neither of MySQL's kinds nor prefix
 * lengths — a GIN or GiST index is how it does the same. Kind and method come from closed lists, hence unquoted.
 */
function indexParts(dialect: Dialect, i: IndexSpec): { keyword: string; method: string; columns: string } {
  const kind = kindOf(i)
  const id = (s: string) => quoteIdent(dialect, s)
  if (dialect === 'postgres') {
    if (kind === 'fulltext' || kind === 'spatial') {
      throw new AdapterError('UNSUPPORTED', 'PostgreSQL has no FULLTEXT / SPATIAL index: use a GIN or GiST index')
    }
    if (i.lengths && Object.keys(i.lengths).length > 0) {
      throw new AdapterError('UNSUPPORTED', 'PostgreSQL has no prefix length on an index column')
    }
    return {
      keyword: kind === 'unique' ? 'UNIQUE ' : '',
      method: i.method ? ` USING ${i.method}` : '',
      columns: i.columns.map(id).join(', '),
    }
  }
  if (i.method && i.method !== 'btree' && i.method !== 'hash') {
    throw new AdapterError('UNSUPPORTED', `MySQL has no ${i.method} index`)
  }
  if (i.method && (kind === 'fulltext' || kind === 'spatial')) {
    throw new AdapterError('UNSUPPORTED', 'A FULLTEXT or SPATIAL index takes no method')
  }
  return {
    keyword: kind === 'index' ? '' : `${kind.toUpperCase()} `,
    method: i.method ? ` USING ${i.method.toUpperCase()}` : '',
    columns: i.columns.map((c) => `${id(c)}${i.lengths?.[c] ? `(${i.lengths[c]})` : ''}`).join(', '),
  }
}

/** `CREATE [UNIQUE | FULLTEXT | SPATIAL] INDEX name ON t [USING m] (cols)` in each dialect's order. */
export function createIndexSql(dialect: Dialect, ns: Namespace, op: IndexSpec): string {
  const { keyword, method, columns } = indexParts(dialect, op)
  const t = quoteTable(dialect, ns, op.table)
  const name = quoteIdent(dialect, op.name)
  // MySQL writes the method after the columns, PostgreSQL before them.
  return dialect === 'postgres'
    ? `CREATE ${keyword}INDEX ${name} ON ${t}${method} (${columns})`
    : `CREATE ${keyword}INDEX ${name} ON ${t} (${columns})${method}`
}

/**
 * The key asked for with a new column: a primary key, or a unique / plain index named after the table and column
 * (PostgreSQL index names share the schema's namespace with tables, so the column name alone could collide).
 */
export function columnKeySql(dialect: Dialect, ns: Namespace, op: Extract<DdlOp, { op: 'addColumn' }>): string[] {
  if (!op.key) return []
  const column = op.column.name
  if (op.key === 'primary') {
    return [`ALTER TABLE ${quoteTable(dialect, ns, op.table)} ADD PRIMARY KEY (${quoteIdent(dialect, column)})`]
  }
  const unique = op.key === 'unique'
  const name = `${op.table}_${column}_${unique ? 'key' : 'idx'}`
  return [createIndexSql(dialect, ns, { table: op.table, name, columns: [column], unique })]
}

/** MySQL's `ADD … INDEX` clause for an ALTER TABLE (the primary key is `ADD PRIMARY KEY`). */
export function mysqlAddIndexClause(i: IndexSpec, primary: boolean): string {
  const { keyword, method, columns } = indexParts('mysql', i)
  return primary
    ? `ADD PRIMARY KEY (${columns})`
    : `ADD ${keyword}INDEX ${quoteIdent('mysql', i.name)} (${columns})${method}`
}

type SplitTable = Extract<DdlOp, { op: 'splitTable' }>
type MoveRepeatingGroup = Extract<DdlOp, { op: 'moveRepeatingGroup' }>

/** A constraint name for the key a normalization adds, kept within both servers' identifier limits. */
const linkName = (table: string, other: string) => `fk_${table}_${other}`.slice(0, 60)

const dropColumnsSql = (dialect: Dialect, ns: Namespace, table: string, columns: readonly string[]) =>
  `ALTER TABLE ${quoteTable(dialect, ns, table)} ${columns.map((c) => `DROP COLUMN ${quoteIdent(dialect, c)}`).join(', ')}`

/**
 * `CREATE TABLE … AS SELECT DISTINCT key, moved FROM t`, then the primary key on the new table (which is where a
 * dependency the rows do not follow is caught), then the foreign key from the original, then the drop.
 */
export function splitTableSql(dialect: Dialect, ns: Namespace, op: SplitTable): string[] {
  const id = (s: string) => quoteIdent(dialect, s)
  const from = quoteTable(dialect, ns, op.table)
  const into = quoteTable(dialect, ns, op.newName)
  const keys = op.keyColumns.map(id).join(', ')
  const notNull = op.keyColumns.map((c) => `${id(c)} IS NOT NULL`).join(' AND ')
  return [
    `CREATE TABLE ${into} AS SELECT DISTINCT ${[...op.keyColumns, ...op.columns].map(id).join(', ')} FROM ${from} WHERE ${notNull}`,
    `ALTER TABLE ${into} ADD PRIMARY KEY (${keys})`,
    addForeignKeySql(dialect, ns, {
      op: 'addForeignKey',
      table: op.table,
      name: linkName(op.table, op.newName),
      columns: op.keyColumns,
      refTable: op.newName,
      refColumns: op.keyColumns,
    }),
    ...(op.dropMoved ? [dropColumnsSql(dialect, ns, op.table, op.columns)] : []),
  ]
}

/** The group's columns as rows: one `SELECT key, column AS value … WHERE column IS NOT NULL` per column, joined. */
export function moveRepeatingGroupSql(dialect: Dialect, ns: Namespace, op: MoveRepeatingGroup): string[] {
  const id = (s: string) => quoteIdent(dialect, s)
  const from = quoteTable(dialect, ns, op.table)
  const into = quoteTable(dialect, ns, op.newName)
  const keys = op.keyColumns.map(id).join(', ')
  const rows = op.columns.map(
    (c) => `SELECT ${keys}, ${id(c)} AS ${id(op.valueColumn)} FROM ${from} WHERE ${id(c)} IS NOT NULL`
  )
  return [
    `CREATE TABLE ${into} AS ${rows.join(' UNION ALL ')}`,
    // MySQL indexes the referencing columns itself when the key is added; PostgreSQL does not, and the lookup
    // from the original's row to its values is what this table is for.
    ...(dialect === 'postgres'
      ? [`CREATE INDEX ${id(`${op.newName}_${op.keyColumns.join('_')}_idx`.slice(0, 60))} ON ${into} (${keys})`]
      : []),
    addForeignKeySql(dialect, ns, {
      op: 'addForeignKey',
      table: op.newName,
      name: linkName(op.newName, op.table),
      columns: op.keyColumns,
      refTable: op.table,
      refColumns: op.keyColumns,
    }),
    ...(op.dropMoved ? [dropColumnsSql(dialect, ns, op.table, op.columns)] : []),
  ]
}
