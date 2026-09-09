import type { ColumnSpec, DdlOp, Namespace } from '@tsmyadmin/shared'
import { addForeignKeySql, createIndexSql } from '../sql/ddl-common.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type DdlBuilder } from '../types.ts'

const id = (s: string) => quoteIdent('mysql', s)

function columnDef(c: ColumnSpec): string {
  // MODIFY COLUMN replaces the whole definition, so anything omitted here is dropped from the column. The
  // collation and ON UPDATE clauses are schema-validated patterns, hence safe to render unquoted.
  const parts = [id(c.name), c.dataType]
  if (c.collation) parts.push(`COLLATE ${c.collation}`)
  parts.push(c.nullable ? 'NULL' : 'NOT NULL')
  if (c.default)
    parts.push(
      `DEFAULT ${c.default.kind === 'literal' ? mysqlLiteral(c.default.value) : defaultExpression(c.default.sql)}`
    )
  if (c.onUpdate) parts.push(`ON UPDATE ${c.onUpdate}`)
  if (c.autoIncrement) parts.push('AUTO_INCREMENT')
  if (c.comment !== null) parts.push(`COMMENT ${mysqlLiteral(c.comment)}`)
  return parts.join(' ')
}

/**
 * MySQL accepts a bare expression default only for `CURRENT_TIMESTAMP`; everything else (`uuid()`, `(a + b)`)
 * must be parenthesised — and that is how `information_schema` prints it back, so an already-wrapped
 * expression is left alone.
 */
function defaultExpression(sql: string): string {
  const s = sql.trim()
  if (/^CURRENT_TIMESTAMP(\(\d?\))?$/i.test(s) || s.startsWith('(')) return s
  // A binary / bit default is not an expression to the server: parentheses would be a syntax error.
  if (/^(?:0x[0-9A-Fa-f]*|[xX]'[0-9A-Fa-f]*'|[bB]'[01]*')$/.test(s)) return s
  return `(${s})`
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
      case 'dropTables':
        return [`DROP TABLE ${op.tables.map((x) => quoteTable('mysql', ns, x)).join(', ')}`]
      case 'truncateTables':
        return op.tables.map((x) => `TRUNCATE TABLE ${quoteTable('mysql', ns, x)}`)
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
        return [`DROP ${op.kind === 'table' ? 'TABLE' : op.kind === 'sequence' ? 'SEQUENCE' : 'VIEW'} ${t}`]
      case 'truncateTable':
        return [`TRUNCATE TABLE ${t}`]
      case 'renameTable':
        return [`RENAME TABLE ${t} TO ${quoteTable('mysql', ns, op.newName)}`]
      case 'setTableOptions': {
        // engine / collation are schema-validated identifiers (`[A-Za-z0-9_]+`), so they are safe unquoted.
        const parts: string[] = []
        if (op.comment !== undefined) parts.push(`COMMENT = ${mysqlLiteral(op.comment ?? '')}`)
        if (op.engine !== undefined) parts.push(`ENGINE = ${op.engine}`)
        if (op.collation !== undefined) parts.push(`COLLATE = ${op.collation}`)
        if (op.autoIncrement !== undefined) parts.push(`AUTO_INCREMENT = ${op.autoIncrement}`)
        if (parts.length === 0) throw new AdapterError('VALIDATION', 'No table option to change')
        return [`ALTER TABLE ${t} ${parts.join(', ')}`]
      }
      case 'maintainTable':
        switch (op.action) {
          case 'analyze':
            return [`ANALYZE TABLE ${t}`]
          case 'optimize':
            return [`OPTIMIZE TABLE ${t}`]
          case 'check':
            return [`CHECK TABLE ${t}`]
          case 'vacuum':
            throw new AdapterError('UNSUPPORTED', 'MySQL has no VACUUM; use OPTIMIZE TABLE')
        }
        break
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
