import type { BrowseResult, Cell, ForeignKeyDef } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'

export interface FkTarget {
  db: string
  schema?: string | undefined
  table: string
  /** Filter that selects the referenced row(s). */
  filters: string
}

/** Single-column foreign keys by source column name (multi-column keys cannot be expressed as one cell link). */
export function linkableForeignKeys(result: BrowseResult): Map<string, ForeignKeyDef> {
  const out = new Map<string, ForeignKeyDef>()
  for (const fk of result.foreignKeys) {
    const col = fk.columns[0]
    if (fk.columns.length === 1 && fk.refColumns.length === 1 && col) out.set(col, fk)
  }
  return out
}

/** Where a foreign-key cell should link to, or null for NULL / binary values. */
export function fkTarget(fk: ForeignKeyDef, value: Cell, currentDb: string): FkTarget | null {
  if (value === null || isBinaryCell(value)) return null
  const refColumn = fk.refColumns[0]
  if (!refColumn) return null
  return {
    db: fk.refNamespace.database || currentDb,
    schema: fk.refNamespace.schema,
    table: fk.refTable,
    filters: JSON.stringify([{ column: refColumn, op: 'eq', value }]),
  }
}
