import type { Cell, ColumnDef, Filter } from '@tsmyadmin/shared'

/** Columns declared as numbers: the axes of the plot. Bit and boolean columns are left out (two values only). */
export function plottableColumns(columns: Pick<ColumnDef, 'name' | 'dataType'>[]): string[] {
  return columns
    .filter(
      (c) => /int|decimal|numeric|float|double|real|serial/i.test(c.dataType) && !/interval|point/i.test(c.dataType)
    )
    .map((c) => c.name)
}

/** The filters that find exactly this row again, from its key columns; null when the table has no usable key. */
export function rowFilters(keyColumns: string[], columns: string[], row: readonly Cell[]): Filter[] | null {
  if (keyColumns.length === 0) return null
  const out: Filter[] = []
  for (const key of keyColumns) {
    const cell = row[columns.indexOf(key)]
    // A binary or cut-off key cannot be typed back into a filter.
    if (cell === undefined || cell === null || typeof cell === 'object') return null
    out.push({ column: key, op: 'eq', value: cell })
  }
  return out
}

/** An axis limited to a range: either end may be left open. Empty text is no limit. */
export function rangeFilters(column: string, min: string, max: string): Filter[] {
  const lo = min.trim()
  const hi = max.trim()
  if (lo !== '' && hi !== '') return [{ column, op: 'between', values: [lo, hi] }]
  if (lo !== '') return [{ column, op: 'gte', value: lo }]
  if (hi !== '') return [{ column, op: 'lte', value: hi }]
  return []
}
