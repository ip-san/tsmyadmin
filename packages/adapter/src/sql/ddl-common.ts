import type { DdlOp, Dialect, Namespace } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'
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
