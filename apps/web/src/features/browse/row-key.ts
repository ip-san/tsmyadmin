import type { BrowseResult, Cell, RowKey } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'

/** Index of each column name in the result's row arrays. */
function columnIndex(result: BrowseResult): Map<string, number> {
  return new Map(result.columns.map((c, i) => [c.name, i]))
}

/** Keys for every row of a page (the column index is built once, not per row). */
export function rowKeys(result: BrowseResult): (RowKey | null)[] {
  const idx = columnIndex(result)
  return result.rows.map((row) => rowKeyFor(result, row, idx))
}

/**
 * Builds the key that addresses `row` for UPDATE/DELETE, or null when the row cannot be addressed safely
 * (views, or all-columns keys containing binary values whose base64 may be truncated).
 */
export function rowKeyFor(result: BrowseResult, row: Cell[], idx = columnIndex(result)): RowKey | null {
  const pick = (names: string[]) => {
    const values: Record<string, Cell> = {}
    for (const n of names) values[n] = row[idx.get(n) ?? -1] ?? null
    return values
  }
  switch (result.keyKind) {
    case 'pk':
      return { kind: 'pk', values: pick(result.keyColumns) }
    case 'ctid': {
      const value = row[result.columns.length - 1]
      return typeof value === 'string' ? { kind: 'ctid', value } : null
    }
    case 'all-columns': {
      if (row.some((c) => isBinaryCell(c))) return null
      return { kind: 'all-columns', values: pick(result.columns.map((c) => c.name)) }
    }
    case 'none':
      return null
  }
}

/** Row values keyed by column name (visible columns only). */
export function rowToValues(result: BrowseResult, row: Cell[]): Record<string, Cell> {
  const columns = result.keyKind === 'ctid' ? result.columns.slice(0, -1) : result.columns
  const out: Record<string, Cell> = {}
  columns.forEach((c, i) => {
    out[c.name] = row[i] ?? null
  })
  return out
}

/** A row's values as text, without one column: identifies the row across an edit of that column. */
export function othersOf(result: BrowseResult, row: Cell[], column: string): string {
  const values = rowToValues(result, row)
  delete values[column]
  return JSON.stringify(values)
}
