import type { ColumnSpec, DdlOp, Namespace } from '@tsmyadmin/shared'
import { addForeignKeySql, createIndexSql } from '../sql/ddl-common.ts'
import { mysqlLiteral } from '../sql/literal.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type DdlBuilder } from '../types.ts'

const id = (s: string) => quoteIdent('mysql', s)

/** CREATE DATABASE, keeping the source's default collation (a schema-validated identifier, so safe unquoted). */
function createDatabaseSql(name: string, collation: string | undefined): string {
  return collation ? `CREATE DATABASE ${id(name)} COLLATE ${collation}` : `CREATE DATABASE ${id(name)}`
}

/**
 * Code as the statement's last part: a trailing `;` would end the statement early (the body of a BEGIN … END
 * block keeps its own).
 */
const bare = (code: string) => code.trim().replace(/[\s;]+$/, '')

function createRoutineSql(ns: Namespace, op: Extract<DdlOp, { op: 'createRoutine' }>): string {
  const params = op.params.map((p) => {
    // MySQL functions take IN parameters only, and do not spell the mode out.
    if (op.kind === 'function' && p.mode !== 'IN') {
      throw new AdapterError('UNSUPPORTED', 'MySQL functions take IN parameters only')
    }
    return `${op.kind === 'procedure' ? `${p.mode} ` : ''}${id(p.name)} ${p.type}`
  })
  const head = `CREATE ${op.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${quoteTable('mysql', ns, op.name)}(${params.join(', ')})`
  if (op.kind === 'function' && !op.returns) throw new AdapterError('UNSUPPORTED', 'A function needs a return type')
  const traits = [
    ...(op.kind === 'function' ? [`RETURNS ${op.returns}`] : []),
    ...(op.comment ? [`COMMENT ${mysqlLiteral(op.comment)}`] : []),
    op.deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC',
  ]
  return `${head} ${traits.join(' ')} ${bare(op.body)}`
}

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
  // Carried verbatim from the catalog (the form cannot compose one) and shown in the preview before it runs.
  if (c.check) parts.push(`CHECK (${c.check})`)
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
      case 'renameDatabase': {
        // MySQL has no RENAME DATABASE, so the tables move to a new one. The old database is deliberately NOT
        // dropped: DROP DATABASE would take whatever was not moved with it, and some of that cannot be seen from
        // here — routines and events the account has no privilege on are invisible to it yet dropped all the same,
        // and a table created between the preview and the run is not on the list. What is left is for the user to
        // inspect and drop through the ordinary, confirmed drop.
        if (!op.tables) throw new AdapterError('VALIDATION', 'renameDatabase needs the list of tables to move')
        const from = { database: op.name }
        const to = { database: op.newName }
        return [
          createDatabaseSql(op.newName, op.collation),
          // One statement for every table: MySQL applies a multi-table RENAME TABLE atomically, so a failure leaves
          // nothing half-moved.
          ...(op.tables.length > 0
            ? [
                `RENAME TABLE ${op.tables.map((t) => `${quoteTable('mysql', from, t)} TO ${quoteTable('mysql', to, t)}`).join(', ')}`,
              ]
            : []),
        ]
      }
      case 'copyDatabase': {
        if (!op.tables) throw new AdapterError('VALIDATION', 'copyDatabase needs the list of tables to copy')
        const from = { database: op.name }
        const to = { database: op.newName }
        const out = [createDatabaseSql(op.newName, op.collation)]
        for (const t of op.tables) {
          const source = quoteTable('mysql', from, t.name)
          const target = quoteTable('mysql', to, t.name)
          // LIKE keeps indexes, keys and AUTO_INCREMENT; foreign keys are not copied (as in copyTable).
          out.push(`CREATE TABLE ${target} LIKE ${source}`)
          if (op.withData && t.columns.length > 0) {
            const cols = t.columns.map((c) => quoteIdent('mysql', c)).join(', ')
            out.push(`INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${source}`)
          }
        }
        return out
      }
      case 'replaceInColumn': {
        const c = id(op.column)
        const replaced = `REPLACE(${c}, ${mysqlLiteral(op.find)}, ${mysqlLiteral(op.replace)})`
        // REPLACE matches bytes; `<>` would compare in the column's collation, where a case-only change
        // (ABC → abc under _ai_ci) is "equal" and the row that changes would be skipped. Compared as bytes.
        const changes = `CAST(${replaced} AS BINARY) <> CAST(${c} AS BINARY)`
        return [`UPDATE ${quoteTable('mysql', ns, op.table)} SET ${c} = ${replaced} WHERE ${changes}`]
      }
      case 'moveTable':
        return [
          `RENAME TABLE ${quoteTable('mysql', ns, op.table)} TO ${quoteTable('mysql', { database: op.to }, op.table)}`,
        ]
      case 'createView':
        return [
          `CREATE ${op.orReplace ? 'OR REPLACE ' : ''}VIEW ${quoteTable('mysql', ns, op.name)} AS ${bare(op.select)}`,
        ]
      case 'createRoutine':
        return [createRoutineSql(ns, op)]
      case 'createTrigger':
        return [
          `CREATE TRIGGER ${quoteTable('mysql', ns, op.name)} ${op.timing} ${op.event} ON ${quoteTable('mysql', ns, op.table)} FOR EACH ROW ${bare(op.body)}`,
        ]
      case 'createEvent': {
        const s = op.schedule
        const schedule =
          s.kind === 'at'
            ? `AT ${mysqlLiteral(s.at)}`
            : [
                `EVERY ${s.interval} ${s.unit}`,
                ...(s.starts ? [`STARTS ${mysqlLiteral(s.starts)}`] : []),
                ...(s.ends ? [`ENDS ${mysqlLiteral(s.ends)}`] : []),
              ].join(' ')
        const comment = op.comment ? ` COMMENT ${mysqlLiteral(op.comment)}` : ''
        return [
          `CREATE EVENT ${quoteTable('mysql', ns, op.name)} ON SCHEDULE ${schedule} ON COMPLETION NOT PRESERVE ${op.enabled ? 'ENABLE' : 'DISABLE'}${comment} DO ${bare(op.body)}`,
        ]
      }
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
          case 'repair':
            // MyISAM / ARCHIVE / CSV only; InnoDB answers with a note saying so rather than an error.
            return [`REPAIR TABLE ${t}`]
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
