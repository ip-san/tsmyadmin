import type { Cell, Dialect, Namespace } from '@tsmyadmin/shared'
import type { SqlExporter } from '../types.ts'
import { cellLiteral } from './literal.ts'
import { quoteIdent, quoteTable } from './quote.ts'

/** Dump statements: every identifier is quoted and every value goes through cellLiteral. Dialect-agnostic. */
export function createExporter(dialect: Dialect): SqlExporter {
  return {
    literal: (cell: Cell) => cellLiteral(dialect, cell),
    insert(ns: Namespace, table: string, columns: string[], rows: Cell[][]): string {
      if (rows.length === 0) return ''
      const cols = columns.map((c) => quoteIdent(dialect, c)).join(', ')
      const values = rows.map((r) => `(${columns.map((_, i) => cellLiteral(dialect, r[i] ?? null)).join(', ')})`)
      return `INSERT INTO ${quoteTable(dialect, ns, table)} (${cols}) VALUES\n${values.join(',\n')};`
    },
  }
}
