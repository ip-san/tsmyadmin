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

/**
 * How far fewer the rows that refer must be before it is said that some rows referred to have none: the two are
 * estimates, each perhaps tens of percent off, so a difference smaller than half is not told.
 */
const FEWER = 0.5

/** How many rows a table has, by the estimate; nothing where there is none. */
export function rowsReading(
  rows: RowEstimates | undefined,
  table: string,
  label: (table: string) => string = (x) => x
): string[] {
  const n = rows?.get(table)
  return n === undefined ? [] : [w.rows(label(table), n)]
}

/**
 * What the estimates say of a key from `child` to `parent`: the rows of `child` per row of `parent` on average (under
 * 0.1, said as such rather than rounded to 0), and, where `child` has half the rows of `parent` or fewer, that some
 * rows of `parent` have none (a row of `child` refers to one row of `parent` at most, so the difference has none, if
 * the estimates hold). Nothing for a key to itself, or where either is not estimated. The names may carry the
 * tables' comments (`label`).
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
  const per = ratio(c / p)
  return [
    per > 0 ? w.perRow(label(parent), label(child), per) : w.perRowFew(label(parent), label(child)),
    ...(c <= p * FEWER ? [w.without(label(parent), label(child), p - c)] : []),
  ]
}
