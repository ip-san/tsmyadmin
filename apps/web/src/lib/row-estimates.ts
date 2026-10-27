import type { TableInfo } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'

const w = locale.designReading

/** The rows of each table as the catalog estimates them, by name: only those worth saying. */
export type RowEstimates = ReadonlyMap<string, number>

/**
 * The tables' row estimates worth saying. The catalog's numbers are estimates (InnoDB samples; PostgreSQL counts at
 * its last ANALYZE), so every sentence says so. Zero is left out with the unknown: a partitioned parent and a table
 * never counted read 0 as well as an empty one.
 */
export function rowEstimates(tables: readonly Pick<TableInfo, 'name' | 'rowEstimate'>[]): Map<string, number> {
  return new Map(tables.flatMap((x) => (x.rowEstimate !== null && x.rowEstimate > 0 ? [[x.name, x.rowEstimate]] : [])))
}

/** A ratio as said: a decimal below 10, a whole number above. */
const ratio = (n: number) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n))

/** How many rows a table has, by the estimate; nothing where there is none. */
export function rowsReading(rows: RowEstimates | undefined, table: string): string[] {
  const n = rows?.get(table)
  return n === undefined ? [] : [w.rows(table, n)]
}

/**
 * What the estimates say of a key from `child` to `parent`: the rows of `child` per row of `parent` on average, and,
 * where `child` has fewer rows, that some rows of `parent` have none (a row of `child` refers to one row of `parent`
 * at most, so at least the difference has none). Nothing for a key to itself, or where either is not estimated.
 * The names may carry the tables' comments (`label`).
 */
export function perRowReading(
  rows: RowEstimates | undefined,
  child: string,
  parent: string,
  label: (table: string) => string = (x) => x
): string[] {
  const c = rows?.get(child)
  const p = rows?.get(parent)
  if (c === undefined || p === undefined || child === parent) return []
  return [
    w.perRow(label(parent), label(child), ratio(c / p)),
    ...(c < p ? [w.without(label(parent), label(child), p - c)] : []),
  ]
}
