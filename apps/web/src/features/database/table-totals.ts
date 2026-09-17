import type { TableInfo } from '@tsmyadmin/shared'

export interface TableTotals {
  count: number
  /** Sum of the known estimates; null when no object has one (a database of views only). */
  rows: number | null
  bytes: number | null
}

/** The footer of the table list, as phpMyAdmin's: how many objects, and their rows and size added up. */
export function tableTotals(tables: readonly Pick<TableInfo, 'rowEstimate' | 'sizeBytes'>[]): TableTotals {
  const sum = (values: (number | null)[]) => {
    const known = values.filter((v): v is number => v !== null)
    return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
  }
  return {
    count: tables.length,
    rows: sum(tables.map((t) => t.rowEstimate)),
    bytes: sum(tables.map((t) => t.sizeBytes)),
  }
}
