import type { ColumnSpec, DdlOp, Namespace } from '@tsmyadmin/shared'
import {
  addForeignKeySql,
  columnKeySql,
  createIndexSql,
  moveRepeatingGroupSql,
  mysqlAddIndexClause,
  splitTableSql,
} from '../sql/ddl-common.ts'
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

/** `DEFINER = 'user'@'host'` (both parts quoted as literals). */
const definerClause = (d: { user: string; host: string } | undefined) =>
  d ? `DEFINER = ${mysqlLiteral(d.user)}@${mysqlLiteral(d.host)} ` : ''

function createRoutineSql(ns: Namespace, op: Extract<DdlOp, { op: 'createRoutine' }>): string {
  const params = op.params.map((p) => {
    // MySQL functions take IN parameters only, and do not spell the mode out.
    if (op.kind === 'function' && p.mode !== 'IN') {
      throw new AdapterError('UNSUPPORTED', 'MySQL functions take IN parameters only')
    }
    return `${op.kind === 'procedure' ? `${p.mode} ` : ''}${id(p.name)} ${p.type}`
  })
  const head = `CREATE ${definerClause(op.definer)}${op.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${quoteTable('mysql', ns, op.name)}(${params.join(', ')})`
  if (op.kind === 'function' && !op.returns) throw new AdapterError('UNSUPPORTED', 'A function needs a return type')
  const traits = [
    ...(op.kind === 'function' ? [`RETURNS ${op.returns}`] : []),
    ...(op.comment ? [`COMMENT ${mysqlLiteral(op.comment)}`] : []),
    op.deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC',
    ...(op.dataAccess ? [op.dataAccess] : []),
    ...(op.sqlSecurity ? [`SQL SECURITY ${op.sqlSecurity}`] : []),
  ]
  return `${head} ${traits.join(' ')} ${bare(op.body)}`
}

/** Where an added or changed column goes: first, after a column, or where it is. */
function position(op: { first?: boolean | undefined; after?: string | undefined }): string {
  return op.first ? ' FIRST' : op.after ? ` AFTER ${id(op.after)}` : ''
}

function columnDef(c: ColumnSpec): string {
  // MODIFY COLUMN replaces the whole definition, so anything omitted here is dropped from the column. The
  // collation and ON UPDATE clauses are schema-validated patterns, hence safe to render unquoted.
  const parts = [id(c.name), c.dataType]
  if (c.collation) parts.push(`COLLATE ${c.collation}`)
  if (c.generated) {
    // The server computes the value: it takes no default, AUTO_INCREMENT or ON UPDATE. The expression is code,
    // shown in the preview before it runs.
    parts.push(`GENERATED ALWAYS AS (${c.generated.expression}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`)
    // Nullable is the default; MariaDB's grammar has no NULL / NOT NULL for a generated column at all.
    if (!c.nullable) parts.push('NOT NULL')
    if (c.comment !== null) parts.push(`COMMENT ${mysqlLiteral(c.comment)}`)
    if (c.check) parts.push(`CHECK (${c.check})`)
    return parts.join(' ')
  }
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

/** A partition's bound as addPartition takes it, from PARTITIONS.PARTITION_DESCRIPTION ('100', 'MAXVALUE', '1,2'). */
export function mysqlPartitionBound(method: string, description: string | null): string {
  if (description === null) return ''
  if (method.startsWith('RANGE'))
    return description === 'MAXVALUE' ? 'VALUES LESS THAN MAXVALUE' : `VALUES LESS THAN (${description})`
  return method.startsWith('LIST') ? `VALUES IN (${description})` : ''
}

export const mysqlDdl: DdlBuilder = {
  build(ns: Namespace, op: DdlOp): string[] {
    // Database-level ops have no table; handle them before touching op.table.
    switch (op.op) {
      case 'createDatabase':
        return [createDatabaseSql(op.name, op.collation)]
      case 'createSchema':
        // MySQL: database and schema are the same object.
        return [`CREATE DATABASE ${id(op.name)}`]

      case 'dropDatabase':
        return [`DROP DATABASE ${id(op.name)}`]
      case 'setServerVariable':
        // A number or a keyword goes in as itself (`ON`, `1`), anything else as a string literal.
        return [
          `SET GLOBAL ${op.name} = ${
            op.value === undefined
              ? 'DEFAULT'
              : /^-?\d+(\.\d+)?$|^(ON|OFF|TRUE|FALSE|DEFAULT)$/i.test(op.value.trim())
                ? op.value.trim()
                : mysqlLiteral(op.value)
          }`,
        ]
      case 'dropDatabases':
        return op.names.map((name) => `DROP DATABASE ${id(name)}`)
      case 'dropRoutine':
        return [`DROP ${op.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${quoteTable('mysql', ns, op.name)}`]
      case 'alterRoutine': {
        // Only characteristics: the body and the DEFINER cannot be altered, only replaced.
        const parts = [
          ...(op.comment !== undefined ? [`COMMENT ${mysqlLiteral(op.comment)}`] : []),
          ...(op.dataAccess ? [op.dataAccess] : []),
          ...(op.sqlSecurity ? [`SQL SECURITY ${op.sqlSecurity}`] : []),
        ]
        if (parts.length === 0) throw new AdapterError('VALIDATION', 'No routine characteristic to change')
        return [
          `ALTER ${op.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${quoteTable('mysql', ns, op.name)} ${parts.join(' ')}`,
        ]
      }
      case 'dropTrigger':
        return [`DROP TRIGGER ${quoteTable('mysql', ns, op.name)}`]
      case 'setDatabaseCollation': {
        const charset = op.collation === 'binary' ? 'binary' : (op.collation.split('_')[0] ?? op.collation)
        const into = { database: op.name }
        return [
          `ALTER DATABASE ${id(op.name)} CHARACTER SET ${charset} COLLATE ${op.collation}`,
          ...(op.applyToTables ? (op.tables ?? []) : []).map(
            (x) =>
              `ALTER TABLE ${quoteTable('mysql', into, x)} CONVERT TO CHARACTER SET ${charset} COLLATE ${op.collation}`
          ),
        ]
      }
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
        const structure = op.structure !== false
        if (!structure && !op.withData)
          throw new AdapterError('VALIDATION', 'Copying neither the structure nor the rows copies nothing')
        const out = structure ? [createDatabaseSql(op.newName, op.collation)] : []
        for (const t of op.tables) {
          const source = quoteTable('mysql', from, t.name)
          const target = quoteTable('mysql', to, t.name)
          // LIKE keeps indexes, keys and AUTO_INCREMENT; foreign keys are not copied (as in copyTable).
          if (structure) out.push(`CREATE TABLE ${target} LIKE ${source}`)
          if (op.withData && t.columns.length > 0) {
            const cols = t.columns.map((c) => quoteIdent('mysql', c)).join(', ')
            out.push(`INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${source}`)
          }
        }
        // After the rows, which would set the counter from their maximum: the source's own next value wins.
        if (op.autoIncrement)
          for (const t of op.tables)
            if (t.autoIncrement)
              out.push(`ALTER TABLE ${quoteTable('mysql', to, t.name)} AUTO_INCREMENT = ${t.autoIncrement}`)
        // A key that pointed into the source database points at the copy's own table instead.
        if (op.foreignKeys && structure)
          for (const t of op.tables)
            for (const fk of t.foreignKeys ?? [])
              out.push(
                addForeignKeySql('mysql', to, {
                  op: 'addForeignKey',
                  table: t.name,
                  ...fk,
                  refDatabase: !fk.refDatabase || fk.refDatabase === op.name ? op.newName : fk.refDatabase,
                })
              )
        if (op.privileges && structure)
          for (const g of op.grants ?? []) {
            const privs = g.privileges.filter((p) => /^[A-Z][A-Z ]*$/.test(p) && p !== 'GRANT OPTION')
            if (privs.length > 0)
              out.push(
                `GRANT ${privs.join(', ')} ON ${id(op.newName)}.* TO ${mysqlLiteral(g.user)}@${mysqlLiteral(g.host)}${g.grantable ? ' WITH GRANT OPTION' : ''}`
              )
          }
        return out
      }
      case 'replaceInColumn': {
        const c = id(op.column)
        const replaced = `${op.regex ? 'REGEXP_REPLACE' : 'REPLACE'}(${c}, ${mysqlLiteral(op.find)}, ${mysqlLiteral(op.replace)})`
        // REPLACE matches bytes; `<>` would compare in the column's collation, where a case-only change
        // (ABC → abc under _ai_ci) is "equal" and the row that changes would be skipped. Compared as bytes.
        const changes = `CAST(${replaced} AS BINARY) <> CAST(${c} AS BINARY)`
        return [`UPDATE ${quoteTable('mysql', ns, op.table)} SET ${c} = ${replaced} WHERE ${changes}`]
      }
      case 'splitTable':
        return splitTableSql('mysql', ns, op)
      case 'moveRepeatingGroup':
        return moveRepeatingGroupSql('mysql', ns, op)
      case 'moveTable':
        return [
          `RENAME TABLE ${quoteTable('mysql', ns, op.table)} TO ${quoteTable('mysql', { database: op.to }, op.table)}`,
        ]
      case 'createView': {
        const cols = op.columns && op.columns.length > 0 ? ` (${op.columns.map(id).join(', ')})` : ''
        const check = op.checkOption ? `\nWITH ${op.checkOption} CHECK OPTION` : ''
        return [
          `CREATE ${op.orReplace ? 'OR REPLACE ' : ''}${op.algorithm ? `ALGORITHM = ${op.algorithm} ` : ''}${definerClause(op.definer)}${op.sqlSecurity ? `SQL SECURITY ${op.sqlSecurity} ` : ''}VIEW ${quoteTable('mysql', ns, op.name)}${cols} AS ${bare(op.select)}${check}`,
        ]
      }
      case 'createRoutine':
        return [createRoutineSql(ns, op)]
      case 'replaceRoutine': {
        // MySQL has no CREATE OR REPLACE for routines, and DDL commits as it goes: the drop is not undone if the
        // new definition is refused, which is why the whole script is shown first.
        const { replaces, op: _replace, ...rest } = op
        return [
          ...mysqlDdl.build(ns, { op: 'dropRoutine', kind: replaces.kind, name: replaces.name }),
          createRoutineSql(ns, { op: 'createRoutine', ...rest }),
        ]
      }
      case 'replaceTrigger': {
        const { replaces, op: _replace, ...rest } = op
        return [
          ...mysqlDdl.build(ns, { op: 'dropTrigger', name: replaces.name, table: replaces.table }),
          ...mysqlDdl.build(ns, { op: 'createTrigger', ...rest }),
        ]
      }
      case 'replaceEvent': {
        const { replaces, op: _replace, ...rest } = op
        return [
          ...mysqlDdl.build(ns, { op: 'dropEvent', name: replaces }),
          ...mysqlDdl.build(ns, { op: 'createEvent', ...rest }),
        ]
      }
      case 'createTrigger':
        return [
          `CREATE ${definerClause(op.definer)}TRIGGER ${quoteTable('mysql', ns, op.name)} ${op.timing} ${op.event} ON ${quoteTable('mysql', ns, op.table)} FOR EACH ROW ${bare(op.body)}`,
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
          `CREATE ${definerClause(op.definer)}EVENT ${quoteTable('mysql', ns, op.name)} ON SCHEDULE ${schedule} ON COMPLETION ${op.preserve ? 'PRESERVE' : 'NOT PRESERVE'} ${op.enabled ? 'ENABLE' : 'DISABLE'}${comment} DO ${bare(op.body)}`,
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
      case 'maintainTables': {
        if (op.action === 'vacuum') throw new AdapterError('UNSUPPORTED', 'MySQL has no VACUUM; use OPTIMIZE TABLE')
        const list = op.tables.map((x) => quoteTable('mysql', ns, x)).join(', ')
        return [`${op.action.toUpperCase()} TABLE ${list}`]
      }
      case 'renameTables':
        // One statement: MySQL renames the whole list atomically.
        return [
          `RENAME TABLE ${op.renames.map((r) => `${quoteTable('mysql', ns, r.from)} TO ${quoteTable('mysql', ns, r.to)}`).join(', ')}`,
        ]
      case 'copyTables':
        return op.tables.flatMap((x) =>
          mysqlDdl.build(ns, {
            op: 'copyTable',
            table: x,
            newName: x,
            withData: op.withData,
            ...(op.toDatabase ? { toDatabase: op.toDatabase } : {}),
            ...(op.details?.[x]?.columns ? { columns: op.details[x].columns } : {}),
          })
        )
      default:
        break
    }
    const t = quoteTable('mysql', ns, op.table)
    switch (op.op) {
      case 'createTable': {
        // MySQL declares RANGE / LIST partitions with the partitioning itself: partition the table once created.
        if (op.partitionBy) throw new AdapterError('UNSUPPORTED', 'MySQL: create the table, then partition it')
        const defs = op.columns.map(columnDef)
        if (op.primaryKey.length > 0) defs.push(`PRIMARY KEY (${op.primaryKey.map(id).join(', ')})`)
        // engine / collation are schema-validated identifiers (`[A-Za-z0-9_]+`), so they are safe unquoted.
        const options = [
          op.engine ? `ENGINE = ${op.engine}` : '',
          op.collation ? `COLLATE = ${op.collation}` : '',
          op.comment ? `COMMENT = ${mysqlLiteral(op.comment)}` : '',
        ].filter(Boolean)
        return [`CREATE TABLE ${t} (\n  ${defs.join(',\n  ')}\n)${options.length > 0 ? ` ${options.join(' ')}` : ''}`]
      }
      case 'partitionTable': {
        const by = `PARTITION BY ${op.method.toUpperCase()} (${op.expression})`
        if (op.method === 'hash' || op.method === 'key')
          return [`ALTER TABLE ${t} ${by}${op.count ? ` PARTITIONS ${op.count}` : ''}`]
        if (op.partitions.length === 0)
          throw new AdapterError('VALIDATION', 'RANGE / LIST partitioning needs its partitions')
        const parts = op.partitions.map((p) => `  PARTITION ${id(p.name)} ${p.bound}`.trimEnd())
        return [`ALTER TABLE ${t} ${by} (\n${parts.join(',\n')}\n)`]
      }
      case 'addPartition':
        return [
          `ALTER TABLE ${t} ADD PARTITION (PARTITION ${id(op.partition.name)}${op.partition.bound ? ` ${op.partition.bound}` : ''})`,
        ]
      case 'dropPartition':
        return [`ALTER TABLE ${t} DROP PARTITION ${id(op.name)}`]
      case 'truncatePartition':
        return [`ALTER TABLE ${t} TRUNCATE PARTITION ${id(op.name)}`]
      case 'detachPartition':
        throw new AdapterError('UNSUPPORTED', 'MySQL has no DETACH PARTITION')
      case 'removePartitioning':
        return [`ALTER TABLE ${t} REMOVE PARTITIONING`]
      case 'maintainPartition':
        return [`ALTER TABLE ${t} ${op.action.toUpperCase()} PARTITION ${id(op.name)}`]
      case 'addColumn':
        return [`ALTER TABLE ${t} ADD COLUMN ${columnDef(op.column)}${position(op)}`, ...columnKeySql('mysql', ns, op)]
      case 'modifyColumn':
        return [
          op.name === op.column.name
            ? `ALTER TABLE ${t} MODIFY COLUMN ${columnDef(op.column)}${position(op)}`
            : `ALTER TABLE ${t} CHANGE COLUMN ${id(op.name)} ${columnDef(op.column)}${position(op)}`,
        ]
      case 'dropColumn':
        return [`ALTER TABLE ${t} DROP COLUMN ${id(op.name)}`]
      case 'dropColumns':
        return [`ALTER TABLE ${t} ${op.names.map((n) => `DROP COLUMN ${id(n)}`).join(', ')}`]
      case 'modifyColumns':
        // One statement: the table is rebuilt once, and either every change lands or none does.
        return [
          `ALTER TABLE ${t} ${op.changes
            .map((c) =>
              c.name === c.column.name
                ? `MODIFY COLUMN ${columnDef(c.column)}`
                : `CHANGE COLUMN ${id(c.name)} ${columnDef(c.column)}`
            )
            .join(', ')}`,
        ]
      case 'reorderColumns':
        // Each column rewritten in its new place, from its full definition (MODIFY replaces it).
        return [
          `ALTER TABLE ${t} ${op.columns
            .map(
              (c, i) =>
                `MODIFY COLUMN ${columnDef(c)} ${i === 0 ? 'FIRST' : `AFTER ${id(op.columns[i - 1]?.name ?? '')}`}`
            )
            .join(', ')}`,
        ]
      case 'setPrimaryKey':
        return [
          `ALTER TABLE ${t} ${op.current ? 'DROP PRIMARY KEY, ' : ''}ADD PRIMARY KEY (${op.columns.map(id).join(', ')})`,
        ]
      case 'addIndex':
        return [createIndexSql('mysql', ns, op)]
      case 'dropIndex':
        return [`DROP INDEX ${id(op.name)} ON ${t}`]
      case 'renameIndex':
        return [`ALTER TABLE ${t} RENAME INDEX ${id(op.name)} TO ${id(op.newName)}`]
      case 'alterIndex': {
        // One ALTER: the old index is never gone without the new one in place.
        const primary = op.name === 'PRIMARY'
        const drop = primary ? 'DROP PRIMARY KEY' : `DROP INDEX ${id(op.name)}`
        return [`ALTER TABLE ${t} ${drop}, ${mysqlAddIndexClause({ ...op.index, table: op.table }, primary)}`]
      }
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
        if (op.rowFormat !== undefined) parts.push(`ROW_FORMAT = ${op.rowFormat}`)
        if (op.checksum !== undefined) parts.push(`CHECKSUM = ${op.checksum ? 1 : 0}`)
        if (op.packKeys !== undefined) parts.push(`PACK_KEYS = ${op.packKeys}`)
        if (op.delayKeyWrite !== undefined) parts.push(`DELAY_KEY_WRITE = ${op.delayKeyWrite ? 1 : 0}`)
        if (op.transactional !== undefined) parts.push(`TRANSACTIONAL = ${op.transactional ? 1 : 0}`)
        if (op.pageChecksum !== undefined) parts.push(`PAGE_CHECKSUM = ${op.pageChecksum ? 1 : 0}`)
        if (op.statsPersistent !== undefined) parts.push(`STATS_PERSISTENT = ${op.statsPersistent}`)
        if (op.statsAutoRecalc !== undefined) parts.push(`STATS_AUTO_RECALC = ${op.statsAutoRecalc}`)
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
          case 'checksum':
            return [`CHECKSUM TABLE ${t}`]
          case 'flush':
            // Needs the RELOAD privilege.
            return [`FLUSH TABLES ${t}`]
        }
        break
      case 'convertCollation': {
        // A MySQL collation name begins with its character set: utf8mb4_0900_ai_ci → utf8mb4.
        const charset = op.collation === 'binary' ? 'binary' : (op.collation.split('_')[0] ?? op.collation)
        return [`ALTER TABLE ${t} CONVERT TO CHARACTER SET ${charset} COLLATE ${op.collation}`]
      }
      case 'orderTable':
        if (!op.column) throw new AdapterError('VALIDATION', 'MySQL orders a table by a column')
        return [`ALTER TABLE ${t} ORDER BY ${id(op.column)}${op.desc ? ' DESC' : ''}`]
      case 'copyTable': {
        const into = { database: op.toDatabase ?? ns.database }
        const target = quoteTable('mysql', into, op.newName)
        // Rows only go into a table that is there: dropping it first would leave nothing to insert into.
        if (op.dropExisting && op.structure === false)
          throw new AdapterError('VALIDATION', 'A data-only copy cannot drop the table it copies into')
        const out = op.dropExisting ? [`DROP TABLE IF EXISTS ${target}`] : []
        // LIKE keeps indexes, keys and AUTO_INCREMENT; foreign keys are added after, when asked for.
        if (op.structure !== false) out.push(`CREATE TABLE ${target} LIKE ${t}`)
        if (op.withData) {
          // Generated columns cannot be inserted, so the caller lists the copyable columns.
          const cols = op.columns?.map((c) => quoteIdent('mysql', c)).join(', ')
          out.push(
            cols
              ? `INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${t}`
              : `INSERT INTO ${target} SELECT * FROM ${t}`
          )
        }
        // The keys still point where the source's do, even when the copy is in another database.
        for (const fk of op.foreignKeys ?? [])
          out.push(
            addForeignKeySql('mysql', into, {
              op: 'addForeignKey',
              table: op.newName,
              ...fk,
              refDatabase: fk.refDatabase ?? ns.database,
            })
          )
        return out
      }
    }
  },
}
