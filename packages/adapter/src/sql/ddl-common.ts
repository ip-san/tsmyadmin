import type { DdlOp, Dialect, Namespace } from '@tsmyadmin/shared'
import { quoteIdent, quoteTable } from './quote.ts'

type AddForeignKey = Extract<DdlOp, { op: 'addForeignKey' }>

/** `ALTER TABLE t ADD CONSTRAINT name FOREIGN KEY (...) REFERENCES ref (...) [ON UPDATE x] [ON DELETE y]` — same on both dialects. */
export function addForeignKeySql(dialect: Dialect, ns: Namespace, op: AddForeignKey): string {
  const id = (s: string) => quoteIdent(dialect, s)
  const actions = [op.onUpdate ? ` ON UPDATE ${op.onUpdate}` : '', op.onDelete ? ` ON DELETE ${op.onDelete}` : '']
  return `ALTER TABLE ${quoteTable(dialect, ns, op.table)} ADD CONSTRAINT ${id(op.name)} FOREIGN KEY (${op.columns
    .map(id)
    .join(
      ', '
    )}) REFERENCES ${quoteTable(dialect, ns, op.refTable)} (${op.refColumns.map(id).join(', ')})${actions.join('')}`
}

/** `CREATE [UNIQUE] INDEX name ON t (cols)` — same on both dialects. */
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
  return [createIndexSql(dialect, ns, { op: 'addIndex', table: op.table, name, columns: [column], unique })]
}

export function createIndexSql(dialect: Dialect, ns: Namespace, op: Extract<DdlOp, { op: 'addIndex' }>): string {
  const id = (s: string) => quoteIdent(dialect, s)
  return `CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX ${id(op.name)} ON ${quoteTable(dialect, ns, op.table)} (${op.columns.map(id).join(', ')})`
}
