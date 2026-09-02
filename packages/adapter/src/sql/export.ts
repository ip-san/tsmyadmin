import type { Cell, Dialect, EventInfo, Namespace, RoutineKind, TableSchema, TriggerInfo } from '@tsmyadmin/shared'
import { isViewKind } from '@tsmyadmin/shared'
import type { ProgramStatement, SqlExporter } from '../types.ts'
import { cellLiteral, pgLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/**
 * Text for a `--` comment line of a dump. Identifiers may contain line breaks on both servers; left as is, a
 * table named `t\nDROP TABLE x` would turn the comment into a statement the restore executes.
 */
export function commentText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

/**
 * Columns whose values the server computes and that therefore cannot be part of an INSERT: MySQL
 * `VIRTUAL GENERATED` / `STORED GENERATED`, PostgreSQL `generated stored`. MySQL's `DEFAULT_GENERATED`
 * (an expression default such as CURRENT_TIMESTAMP) is an ordinary column whose values must be dumped.
 */
export function isGeneratedColumn(extra: string): boolean {
  return /^(?:(?:VIRTUAL|STORED) )?GENERATED\b/i.test(extra)
}

/**
 * Moves the sequence behind an identity / serial column past the values now in the table. Nothing happens for
 * an empty table or when there is no sequence, and the value is clamped to the sequence minimum (a `MINVALUE
 * 1000` sequence must not be set to 1, nor to a negative id).
 */
export function pgAdvanceSequence(quotedTable: string, column: string): string {
  const col = quoteIdent('postgres', column)
  return `SELECT setval(s.seqrelid, GREATEST(m.max_id, s.seqmin), m.max_id >= s.seqmin) FROM (SELECT MAX(${col})::bigint AS max_id FROM ${quotedTable}) m JOIN pg_sequence s ON s.seqrelid = pg_get_serial_sequence(${pgLiteral(quotedTable)}, ${pgLiteral(column)})::regclass WHERE m.max_id IS NOT NULL`
}

/**
 * Table reference inside a dump. MySQL dumps name tables without the database (as mysqldump does): SHOW CREATE
 * TABLE is unqualified anyway, and the target database is chosen at import time — a dump of `prod` must restore
 * into `staging` without touching `prod`. PostgreSQL dumps are schema-qualified (search_path is set as well).
 */
function dumpTable(dialect: Dialect, ns: Namespace, table: string): string {
  return dialect === 'mysql' ? quoteIdent(dialect, table) : quoteTable(dialect, ns, table)
}

/**
 * The `DEFINER=user@host` clause in the header of a MySQL CREATE statement (view, routine). Anchored to the
 * header so the same text inside a body's string literal (`SELECT 'DEFINER=root@localhost'`) is left alone.
 */
const DEFINER =
  /^(CREATE\s+(?:ALGORITHM\s*=\s*\w+\s+)?)DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*')@(?:`(?:[^`]|``)*`|'(?:[^']|'')*')\s+/i

/** Dump statements: every identifier is quoted and every value goes through cellLiteral. Dialect-agnostic. */
export function createExporter(dialect: Dialect): SqlExporter {
  const id = (name: string) => quoteIdent(dialect, name)
  const withoutDefiner = (sql: string, strip: boolean) =>
    strip && dialect === 'mysql' ? sql.replace(DEFINER, '$1') : sql
  const lit = (text: string) => cellLiteral(dialect, text)
  return {
    withoutDefiner: (sql) => withoutDefiner(sql, true),
    routine(_ns, kind: RoutineKind, name, definition, stripDefiner): ProgramStatement {
      // PostgreSQL's pg_get_functiondef is a CREATE OR REPLACE (a DROP would fail while a trigger depends on
      // the function); MySQL has no OR REPLACE for routines, so it drops first. The dump is database-relative.
      if (dialect === 'postgres') return { sql: definition }
      const object = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      return { sql: `DROP ${object} IF EXISTS ${id(name)}$$\n${withoutDefiner(definition, stripDefiner)}` }
    },
    trigger(ns, t: TriggerInfo): ProgramStatement {
      if (dialect === 'mysql') {
        // information_schema carries the body only; the header comes from the trigger's metadata.
        return {
          sql: `DROP TRIGGER IF EXISTS ${id(t.name)}$$\nCREATE TRIGGER ${id(t.name)} ${t.timing} ${t.events} ON ${id(t.table)} FOR EACH ${t.orientation}\n${t.definition ?? ''}`,
          sqlMode: t.sqlMode,
        }
      }
      return {
        sql: `DROP TRIGGER IF EXISTS ${id(t.name)} ON ${quoteTable(dialect, ns, t.table)};\n${t.definition ?? ''}`,
      }
    },
    event(_ns, e: EventInfo): ProgramStatement {
      const schedule = e.schedule.startsWith('AT ') ? `AT ${lit(e.schedule.slice(3))}` : e.schedule
      const starts = e.starts ? ` STARTS ${lit(e.starts)}` : ''
      const ends = e.ends ? ` ENDS ${lit(e.ends)}` : ''
      const completion = e.onCompletion ? ` ON COMPLETION ${e.onCompletion}` : ''
      const status = e.status === 'ENABLED' ? 'ENABLE' : 'DISABLE'
      const comment = e.comment ? ` COMMENT ${lit(e.comment)}` : ''
      return {
        sql: `DROP EVENT IF EXISTS ${id(e.name)}$$\nCREATE EVENT ${id(e.name)} ON SCHEDULE ${schedule}${starts}${ends}${completion} ${status}${comment}\nDO ${e.definition ?? ''}`,
        sqlMode: e.sqlMode,
        timeZone: e.timeZone,
      }
    },
    programBlock(statements) {
      if (statements.length === 0) return ''
      if (dialect !== 'mysql') return statements.map((s) => `${s.sql};\n\n`).join('')
      // MySQL stores the creating session's sql_mode (and an event's time zone) into the program: set them
      // around each CREATE as mysqldump does, then restore the dump's own settings.
      const parts = statements.map((s) => {
        const mode = s.sqlMode === undefined || s.sqlMode === null ? '' : `SET sql_mode = ${lit(s.sqlMode)}$$\n`
        const zone = s.timeZone ? `SET time_zone = ${lit(s.timeZone)}$$\n` : ''
        return `${mode}${zone}${s.sql}$$\n\n`
      })
      return `SET @tsmyadmin_sql_mode = @@sql_mode;\nSET @tsmyadmin_time_zone = @@time_zone;\nDELIMITER $$\n${parts.join('')}DELIMITER ;\nSET sql_mode = @tsmyadmin_sql_mode;\nSET time_zone = @tsmyadmin_time_zone;\n\n`
    },
    preamble: (ns: Namespace) =>
      dialect === 'postgres'
        ? // Index / view definitions are printed relative to the schema, so restore into it explicitly. Function
          // bodies are not validated at creation (pg_dump does the same) so their order does not matter.
          [`SET search_path TO ${quoteIdent(dialect, ns.schema ?? 'public')};`, 'SET check_function_bodies = false;']
        : [
            `-- Database: ${commentText(ns.database)} (statements are unqualified: import into the database of your choice)`,
            // Literals are written with backslash escapes, which NO_BACKSLASH_ESCAPES would break on import.
            "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
            'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;',
          ],
    postamble: () =>
      dialect === 'mysql' ? ['SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;'] : [],
    literal: (cell: Cell) => cellLiteral(dialect, cell),
    dropIfExists(ns: Namespace, schema: TableSchema): string {
      const kind =
        schema.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : isViewKind(schema.kind) ? 'VIEW' : 'TABLE'
      // CASCADE (PostgreSQL) so a table referenced by a foreign key can be replaced; MySQL disables FK checks instead.
      return `DROP ${kind} IF EXISTS ${dumpTable(dialect, ns, schema.name)}${dialect === 'postgres' ? ' CASCADE' : ''}`
    },
    insert(ns: Namespace, table: string, columns: string[], rows: Cell[][], options = {}): string {
      if (rows.length === 0) return ''
      const cols = columns.map((c) => quoteIdent(dialect, c)).join(', ')
      const values = rows.map((r) => `(${columns.map((_, i) => cellLiteral(dialect, r[i] ?? null)).join(', ')})`)
      const overriding = dialect === 'postgres' && options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''
      return `INSERT INTO ${dumpTable(dialect, ns, table)} (${cols})${overriding} VALUES\n${values.join(',\n')};`
    },
    afterData(ns: Namespace, schema: TableSchema): string[] {
      if (dialect !== 'postgres') return [] // AUTO_INCREMENT follows explicit values on MySQL
      const t = quoteTable(dialect, ns, schema.name)
      return schema.columns
        .filter((c) => c.extra.startsWith('identity') || c.extra === 'serial')
        .map((c) => `${pgAdvanceSequence(t, c.name)};`)
    },
  }
}
