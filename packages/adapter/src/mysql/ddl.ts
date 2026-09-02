import type { ColumnSpec, DdlOp, Namespace } from '@tsmyadmin/shared'
import { addForeignKeySql, createIndexSql } from '../sql/ddl-common.ts'
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
    // Database-level ops have no table; handle them before touching op.table.
    switch (op.op) {
      case 'createDatabase':
      case 'createSchema':
        // MySQL: database and schema are the same object.
        return [`CREATE DATABASE ${id(op.name)}`]

      case 'dropDatabase':
        return [`DROP DATABASE ${id(op.name)}`]
      case 'enableEvent':
        return [`ALTER EVENT ${quoteTable('mysql', ns, op.name)} ENABLE`]
      case 'disableEvent':
        return [`ALTER EVENT ${quoteTable('mysql', ns, op.name)} DISABLE`]
      case 'dropEvent':
        return [`DROP EVENT ${quoteTable('mysql', ns, op.name)}`]
      default:
        break
    }
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
        return [createIndexSql('mysql', ns, op)]
      case 'dropIndex':
        return [`DROP INDEX ${id(op.name)} ON ${t}`]
      case 'addForeignKey':
        return [addForeignKeySql('mysql', ns, op)]
      case 'dropForeignKey':
        return [`ALTER TABLE ${t} DROP FOREIGN KEY ${id(op.name)}`]
      case 'dropTable':
        return [`DROP TABLE ${t}`]
      case 'truncateTable':
        return [`TRUNCATE TABLE ${t}`]
      case 'renameTable':
        return [`RENAME TABLE ${t} TO ${quoteTable('mysql', ns, op.newName)}`]
      case 'copyTable': {
        const target = quoteTable('mysql', ns, op.newName)
        // LIKE keeps indexes, keys and AUTO_INCREMENT; foreign keys are not copied (as in phpMyAdmin).
        const out = [`CREATE TABLE ${target} LIKE ${t}`]
        if (op.withData) {
          // Generated columns cannot be inserted, so the caller lists the copyable columns.
          const cols = op.columns?.map((c) => quoteIdent('mysql', c)).join(', ')
          out.push(
            cols
              ? `INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${t}`
              : `INSERT INTO ${target} SELECT * FROM ${t}`
          )
        }
        return out
      }
    }
  },
}
