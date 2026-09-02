import type { Cell, Dialect, Namespace, TableSchema } from '@tsmyadmin/shared'
import { isViewKind } from '@tsmyadmin/shared'
import type { SqlExporter } from '../types.ts'
import { cellLiteral, pgLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/** Columns whose values the server computes and that therefore cannot be part of an INSERT (both dialects). */
export function isGeneratedColumn(extra: string): boolean {
  return /generated/i.test(extra)
}

/** Dump statements: every identifier is quoted and every value goes through cellLiteral. Dialect-agnostic. */
export function createExporter(dialect: Dialect): SqlExporter {
  return {
    preamble: () =>
      dialect === 'mysql'
        ? [
            // Literals are written with backslash escapes, which NO_BACKSLASH_ESCAPES would break on import.
            "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
            'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;',
          ]
        : [],
    postamble: () =>
      dialect === 'mysql' ? ['SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;'] : [],
    literal: (cell: Cell) => cellLiteral(dialect, cell),
    dropIfExists(ns: Namespace, schema: TableSchema): string {
      const kind =
        schema.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : isViewKind(schema.kind) ? 'VIEW' : 'TABLE'
      return `DROP ${kind} IF EXISTS ${quoteTable(dialect, ns, schema.name)}`
    },
    insert(ns: Namespace, table: string, columns: string[], rows: Cell[][], options = {}): string {
      if (rows.length === 0) return ''
      const cols = columns.map((c) => quoteIdent(dialect, c)).join(', ')
      const values = rows.map((r) => `(${columns.map((_, i) => cellLiteral(dialect, r[i] ?? null)).join(', ')})`)
      const overriding = dialect === 'postgres' && options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''
      return `INSERT INTO ${quoteTable(dialect, ns, table)} (${cols})${overriding} VALUES\n${values.join(',\n')};`
    },
    afterData(ns: Namespace, schema: TableSchema): string[] {
      if (dialect !== 'postgres') return [] // AUTO_INCREMENT follows explicit values on MySQL
      const t = quoteTable(dialect, ns, schema.name)
      return schema.columns
        .filter((c) => c.extra.startsWith('identity') || c.extra === 'serial')
        .map(
          (c) =>
            `SELECT setval(pg_get_serial_sequence(${pgLiteral(t)}, ${pgLiteral(c.name)}), COALESCE(MAX(${quoteIdent(dialect, c.name)}), 1), MAX(${quoteIdent(dialect, c.name)}) IS NOT NULL) FROM ${t};`
        )
    },
  }
}
