import type { Cell, Namespace } from '@tsmyadmin/shared'
import { cellLiteral } from '../sql/literal.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import type { SqlExporter } from '../types.ts'

const DIALECT = 'postgres'

/** Dump statements for postgres. Every identifier is quoted and every value goes through cellLiteral. */
export const pgExporter: SqlExporter = {
  literal: (cell: Cell) => cellLiteral(DIALECT, cell),
  insert(ns: Namespace, table: string, columns: string[], rows: Cell[][]): string {
    if (rows.length === 0) return ''
    const cols = columns.map((c) => quoteIdent(DIALECT, c)).join(', ')
    const values = rows.map((r) => `(${columns.map((_, i) => cellLiteral(DIALECT, r[i] ?? null)).join(', ')})`)
    return `INSERT INTO ${quoteTable(DIALECT, ns, table)} (${cols}) VALUES\n${values.join(',\n')};`
  },
}
