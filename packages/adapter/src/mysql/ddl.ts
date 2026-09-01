import type { ColumnSpec, DdlOp, Namespace } from '@tsmyadmin/shared'
import { mysqlLiteral } from '../sql/literal.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import type { DdlBuilder } from '../types.ts'

const id = (s: string) => quoteIdent('mysql', s)

function columnDef(c: ColumnSpec): string {
  const parts = [id(c.name), c.dataType, c.nullable ? 'NULL' : 'NOT NULL']
  if (c.default) parts.push(`DEFAULT ${c.default.kind === 'literal' ? mysqlLiteral(c.default.value) : c.default.sql}`)
  if (c.autoIncrement) parts.push('AUTO_INCREMENT')
  if (c.comment !== null) parts.push(`COMMENT ${mysqlLiteral(c.comment)}`)
  return parts.join(' ')
}

export const mysqlDdl: DdlBuilder = {
  build(ns: Namespace, op: DdlOp): string[] {
    const t = quoteTable('mysql', ns, op.table)
    switch (op.op) {
      case 'createTable': {
        const defs = op.columns.map(columnDef)
        if (op.primaryKey.length > 0) defs.push(`PRIMARY KEY (${op.primaryKey.map(id).join(', ')})`)
        return [`CREATE TABLE ${t} (\n  ${defs.join(',\n  ')}\n)`]
      }
      case 'addColumn':
        return [`ALTER TABLE ${t} ADD COLUMN ${columnDef(op.column)}${op.after ? ` AFTER ${id(op.after)}` : ''}`]
      case 'modifyColumn':
        return [
          op.name === op.column.name
            ? `ALTER TABLE ${t} MODIFY COLUMN ${columnDef(op.column)}`
            : `ALTER TABLE ${t} CHANGE COLUMN ${id(op.name)} ${columnDef(op.column)}`,
        ]
      case 'dropColumn':
        return [`ALTER TABLE ${t} DROP COLUMN ${id(op.name)}`]
      case 'addIndex':
        return [`CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX ${id(op.name)} ON ${t} (${op.columns.map(id).join(', ')})`]
      case 'dropIndex':
        return [`DROP INDEX ${id(op.name)} ON ${t}`]
      case 'dropTable':
        return [`DROP TABLE ${t}`]
      case 'truncateTable':
        return [`TRUNCATE TABLE ${t}`]
    }
  },
}
