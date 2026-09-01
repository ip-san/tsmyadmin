import type { BrowseResult, Cell, RowKey } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'

/** Index of each column name in the result's row arrays. */
function columnIndex(result: BrowseResult): Map<string, number> {
  return new Map(result.columns.map((c, i) => [c.name, i]))
}

/**
 * Builds the key that addresses `row` for UPDATE/DELETE, or null when the row cannot be addressed safely
 * (views, or all-columns keys containing binary values whose base64 may be truncated).
 */
export function rowKeyFor(result: BrowseResult, row: Cell[]): RowKey | null {
  const idx = columnIndex(result)
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
