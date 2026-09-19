import { useQueries, useQuery } from '@tanstack/react-query'
import type { BrowseOptions, BrowseResult, Cell, ColumnDef, ForeignKeyDef } from '@tsmyadmin/shared'
import { rowsQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { visibleColumns } from './browse-search.ts'

/** The column that names a referenced row: its table's first text column other than the referenced one. */
export function displayColumn(columns: Pick<ColumnDef, 'name' | 'dataType'>[], refColumn: string): string | null {
  return columns.find((c) => c.name !== refColumn && /char|text/i.test(c.dataType))?.name ?? null
}

/** A value that can be looked up again: text or a number (not NULL, binary or cut off). */
const plain = (cell: Cell | undefined): cell is string | number => typeof cell === 'string' || typeof cell === 'number'

/** Label lookup for single-column foreign keys: column → (value as text → the referenced row's display value). */
export type FkLabels = ReadonlyMap<string, ReadonlyMap<string, string>>

/**
 * phpMyAdmin's foreign key display column: beside each foreign key value on the page, the referenced row's name.
 * One lookup per key per page (the referenced rows whose key is IN the page's values); nothing when `enabled` is
 * off. The page itself comes from the query cache the grid already filled.
 */
export function useFkLabels(tableRef: TableRef, options: BrowseOptions, enabled: boolean): FkLabels {
  const page = useQuery({ ...rowsQuery(tableRef, options), enabled })
  const data = page.data
  const keys: { fk: ForeignKeyDef; column: string; refColumn: string; values: (string | number)[] }[] = []
  if (enabled && data) {
    const names = visibleColumns(data).map((c) => c.name)
    for (const fk of data.foreignKeys) {
      const column = fk.columns[0]
      const refColumn = fk.refColumns[0]
      if (fk.columns.length !== 1 || !column || !refColumn) continue
      const at = names.indexOf(column)
      const values = [...new Set(data.rows.map((r) => r[at]).filter(plain))]
      if (values.length > 0) keys.push({ fk, column, refColumn, values })
    }
  }
  const refOf = (fk: ForeignKeyDef): TableRef => ({
    db: fk.refNamespace.database,
    schema: fk.refNamespace.schema,
    table: fk.refTable,
  })
  const structures = useQueries({ queries: keys.map((k) => structureQuery(refOf(k.fk))) })
  const lookups = useQueries({
    queries: keys.map((k, i) => {
      const show = structures[i]?.data ? displayColumn(structures[i].data.columns, k.refColumn) : null
      return {
        ...rowsQuery(refOf(k.fk), {
          offset: 0,
          limit: k.values.length,
          sort: [],
          filters: [{ column: k.refColumn, op: 'in' as const, values: k.values }],
        }),
        enabled: show !== null,
        select: (r: BrowseResult) => {
          const cols = r.columns.map((c) => c.name)
          const from = cols.indexOf(k.refColumn)
          const to = show === null ? -1 : cols.indexOf(show)
          const out = new Map<string, string>()
          for (const row of r.rows) {
            const key = row[from]
            const label = row[to]
            if (plain(key) && plain(label)) out.set(String(key), String(label))
          }
          return out
        },
      }
    }),
  })
  const labels = new Map<string, ReadonlyMap<string, string>>()
  keys.forEach((k, i) => {
    const found = lookups[i]?.data
    if (found) labels.set(k.column, found)
  })
  return labels
}
