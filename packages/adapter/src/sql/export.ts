import type { Cell, Dialect, Namespace } from '@tsmyadmin/shared'
import type { SqlExporter } from '../types.ts'
import { cellLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

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
    insert(ns: Namespace, table: string, columns: string[], rows: Cell[][]): string {
      if (rows.length === 0) return ''
      const cols = columns.map((c) => quoteIdent(dialect, c)).join(', ')
      const values = rows.map((r) => `(${columns.map((_, i) => cellLiteral(dialect, r[i] ?? null)).join(', ')})`)
      return `INSERT INTO ${quoteTable(dialect, ns, table)} (${cols}) VALUES\n${values.join(',\n')};`
    },
  }
}
