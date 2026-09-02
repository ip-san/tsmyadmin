import type { Cell, Dialect, Namespace, TableSchema } from '@tsmyadmin/shared'
import { isViewKind } from '@tsmyadmin/shared'
import type { SqlExporter } from '../types.ts'
import { cellLiteral, pgLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

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

/** Dump statements: every identifier is quoted and every value goes through cellLiteral. Dialect-agnostic. */
export function createExporter(dialect: Dialect): SqlExporter {
  return {
    preamble: (ns: Namespace) =>
      dialect === 'postgres'
        ? // Index / view definitions are printed relative to the schema, so restore into it explicitly.
          [`SET search_path TO ${quoteIdent(dialect, ns.schema ?? 'public')};`]
        : [
            `-- Database: ${ns.database} (statements are unqualified: import into the database of your choice)`,
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
