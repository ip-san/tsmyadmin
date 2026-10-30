import type { TableInfo } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'

const w = locale.designReading

/** A table's rows counted exactly (`COUNT(*)`, run when asked for), not estimated. */
interface CountedRows {
  counted: number
}

/**
 * The rows of each table, by name: the catalog's estimate (a number; only those worth saying), or where asked for,
 * the rows counted (`CountedRows`, zero kept: a count of none is exact).
 */
export type RowEstimates = ReadonlyMap<string, number | CountedRows>

/** The rows of a table, and whether they were counted; nothing where there is no number. */
export function rowsOf(rows: RowEstimates | undefined, table: string): { n: number; counted: boolean } | undefined {
  const v = rows?.get(table)
  if (v === undefined) return undefined
  return typeof v === 'number' ? { n: v, counted: false } : { n: v.counted, counted: true }
}

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

/** How many rows a table has, counted or by the estimate; nothing where there is neither. */
export function rowsReading(
  rows: RowEstimates | undefined,
  table: string,
  label: (table: string) => string = (x) => x
): string[] {
  const r = rowsOf(rows, table)
  if (!r) return []
  return [r.counted ? w.rowsCounted(label(table), r.n) : w.rows(label(table), r.n)]
}

/**
 * What the rows say of a key from `child` to `parent`: the rows of `child` per row of `parent` on average (under 0.1,
 * said as such rather than rounded to 0), and that some rows of `parent` have none. A row of `child` refers to one
 * row of `parent` at most (a key refers to a unique key, as it does but for MySQL's lenient keys), so where `child`
 * has fewer rows, at least the difference have none. Counted, both, that is
 * so for any difference; by the estimates (each perhaps tens of percent off), it is said only where `child` has half
 * the rows of `parent` or fewer. Nothing for a key to itself, or where either has no number; a table counted with
 * one estimated is told as estimated. The names may carry the tables' comments (`label`).
 */
export function perRowReading(
  rows: RowEstimates | undefined,
  child: string,
  parent: string,
  label: (table: string) => string = (x) => x
): string[] {
  const c = rowsOf(rows, child)
  const p = rowsOf(rows, parent)
  if (c === undefined || p === undefined || child === parent) return []
  const [pl, cl] = [label(parent), label(child)]
  if (c.counted && p.counted) {
    // No rows referred to: no ratio to say.
    if (p.n === 0) return []
    const per = ratio(c.n / p.n)
    return [
      // None counted is exact: what is said is that no row of `parent` has one.
      ...(c.n === 0 ? [] : [per > 0 ? w.perRowCounted(pl, cl, per) : w.perRowFewCounted(pl, cl)]),
      ...(c.n < p.n ? [w.withoutCounted(pl, cl, p.n - c.n)] : []),
    ]
  }
  const per = ratio(c.n / p.n)
  return [
    per > 0 ? w.perRow(pl, cl, per) : w.perRowFew(pl, cl),
    ...(c.n <= p.n * FEWER ? [w.without(pl, cl, p.n - c.n)] : []),
  ]
}
