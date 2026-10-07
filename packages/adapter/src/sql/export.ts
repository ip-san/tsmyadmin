import { type Cell, capabilities, type Dialect, isViewKind, type Namespace, type TableSchema } from '@tsmyadmin/shared'
import { AdapterError, type DropTarget, type InsertOptions, type SqlExporter } from '../types.ts'
import { cellLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/**
 * Text for a `--` comment line of a dump. Identifiers may contain line breaks on both servers; left as is, a
 * table named `t\nDROP TABLE x` would turn the comment into a statement the restore executes.
 */
export function commentText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

/** The statements that create the database (MySQL) or schema (PostgreSQL) a dump works in, and enter it. */
export function createNamespaceStatements(dialect: Dialect, ns: Namespace): string[] {
  if (!capabilities(dialect).databasesAreSchemas)
    return [`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(dialect, ns.schema ?? 'public')};`]
  return [
    `CREATE DATABASE IF NOT EXISTS ${quoteIdent(dialect, ns.database)};`,
    `USE ${quoteIdent(dialect, ns.database)};`,
  ]
}

/** A table of the given columns (names and types only: what a view has to give a table of its own). */
export function createTableFromColumns(
  dialect: Dialect,
  name: string,
  columns: { name: string; dataType: string; nullable: boolean }[]
): string {
  const id = (n: string) => quoteIdent(dialect, n)
  const list = columns.map((c) => `  ${id(c.name)} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`).join(',\n')
  return `CREATE TABLE ${id(name)} (\n${list}\n)`
}

/**
 * Table reference inside a dump. MySQL dumps name tables without the database (as mysqldump does): SHOW CREATE
 * TABLE is unqualified anyway, and the target database is chosen at import time — a dump of `prod` must restore
 * into `staging` without touching `prod`. PostgreSQL dumps are schema-qualified (search_path is set as well).
 */
function dumpTable(dialect: Dialect, ns: Namespace, table: string): string {
  return capabilities(dialect).databasesAreSchemas ? quoteIdent(dialect, table) : quoteTable(dialect, ns, table)
}

/** What differs between the servers in an INSERT: the verb, whether the rows need a key, and what follows the values. */
export interface InsertStyle {
  /** The statement keyword for the kind of write (`INSERT`, `REPLACE`, `INSERT IGNORE`). */
  verb(kind: 'insert' | 'replace', options: InsertOptions): string
  /** Whether this kind of write finds its row by the key columns (an UPDATE always does). */
  needsKey(kind: 'insert' | 'replace' | 'update'): boolean
  /** Written between the column list and VALUES (PostgreSQL: `OVERRIDING SYSTEM VALUE`). */
  overriding(options: InsertOptions): string
  /** Written after the last row: what to do with a row that is already there (PostgreSQL: `ON CONFLICT …`). */
  conflict(columns: string[], keys: string[], kind: 'insert' | 'replace', options: InsertOptions): string
}

/**
 * The parts of a dump exporter that are the same on both servers, written once: every identifier is quoted and every
 * value goes through cellLiteral. A dialect's file adds what only its server has (routines, triggers, the preamble).
 */
export function createCommonExporter(
  dialect: Dialect,
  style: InsertStyle,
  /** `name(identity arguments)` for DROP FUNCTION / PROCEDURE, read from a CREATE statement; null where not applicable. */
  routineSignature: (statement: string) => string | null
): Pick<SqlExporter, 'literal' | 'dropAll' | 'dropIfExists' | 'insert'> {
  const id = (name: string) => quoteIdent(dialect, name)
  return {
    literal: (cell: Cell) => cellLiteral(dialect, cell),
    dropAll(ns: Namespace, objects: DropTarget[]): string[] {
      const out: string[] = []
      const tables: string[] = []
      for (const o of objects) {
        if (o.kind === 'table') tables.push(dumpTable(dialect, ns, o.name))
        else if (o.kind === 'routine') {
          for (const s of o.statements) {
            const signature = routineSignature(s)
            const object = /^CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE/i.test(s) ? 'PROCEDURE' : 'FUNCTION'
            if (signature) out.push(`DROP ${object} IF EXISTS ${signature}`)
          }
        } else if (o.kind !== 'sequence') {
          const kind = o.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'VIEW'
          out.push(`DROP ${kind} IF EXISTS ${dumpTable(dialect, ns, o.name)}`)
        }
      }
      if (tables.length > 0) out.push(`DROP TABLE IF EXISTS ${tables.join(', ')}`)
      // After the tables whose defaults call them (a column-owned sequence is already gone with its table).
      for (const o of objects)
        if (o.kind === 'sequence') out.push(`DROP SEQUENCE IF EXISTS ${dumpTable(dialect, ns, o.name)}`)
      return out
    },
    dropIfExists(ns: Namespace, schema: Pick<TableSchema, 'name' | 'kind'>): string {
      const kind =
        schema.kind === 'materialized_view'
          ? 'MATERIALIZED VIEW'
          : schema.kind === 'sequence'
            ? 'SEQUENCE'
            : isViewKind(schema.kind)
              ? 'VIEW'
              : 'TABLE'
      // MySQL restores with FOREIGN_KEY_CHECKS off; PostgreSQL dumps drop everything up front through dropAll.
      return `DROP ${kind} IF EXISTS ${dumpTable(dialect, ns, schema.name)}`
    },
    insert(ns: Namespace, table: string, columns: string[], rows: Cell[][], options: InsertOptions = {}): string {
      if (rows.length === 0) return ''
      const target = dumpTable(dialect, ns, table)
      const literalRow = (r: Cell[]) => columns.map((_, i) => cellLiteral(dialect, r[i] ?? null))
      const kind = options.kind ?? 'insert'
      const keys = options.keyColumns ?? []
      if (style.needsKey(kind) && keys.length === 0)
        throw new AdapterError(
          'VALIDATION',
          `${kind === 'update' ? 'UPDATE' : 'REPLACE'} needs a primary key on ${table}`
        )
      if (kind === 'update') {
        const at = (name: string) => columns.indexOf(name)
        const rest = columns.filter((c) => !keys.includes(c))
        // A table whose every column is its key has nothing to update.
        if (rest.length === 0) return ''
        return rows
          .map((r) => {
            const values = literalRow(r)
            const set = rest.map((c) => `${id(c)} = ${values[at(c)]}`).join(', ')
            const where = keys.map((k) => `${id(k)} = ${values[at(k)]}`).join(' AND ')
            return `UPDATE ${target} SET ${set} WHERE ${where};`
          })
          .join('\n')
      }
      const verb = style.verb(kind, options)
      const list = options.columnNames === false ? '' : ` (${columns.map(id).join(', ')})`
      const overriding = style.overriding(options)
      const conflict = style.conflict(columns, keys, kind, options)
      const head = `${verb} INTO ${target}${list}${overriding} VALUES\n`
      const values = rows.map((r) => `(${literalRow(r).join(', ')})`)
      // One row to a statement, or as many as fit under the byte limit (a row longer than it goes out alone).
      const groups: string[][] = []
      if (options.extended === false) for (const v of values) groups.push([v])
      else {
        const limit = options.maxQuery && options.maxQuery > 0 ? options.maxQuery : Number.POSITIVE_INFINITY
        let current: string[] = []
        let size = head.length
        for (const v of values) {
          if (current.length > 0 && size + v.length + 2 > limit) {
            groups.push(current)
            current = []
            size = head.length
          }
          current.push(v)
          size += v.length + 2
        }
        if (current.length > 0) groups.push(current)
      }
      return groups.map((g) => `${head}${g.join(',\n')}${conflict};`).join('\n')
    },
  }
}
