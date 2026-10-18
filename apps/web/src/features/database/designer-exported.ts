import type { RelationDef } from '@tsmyadmin/shared'
import { boxColumns, withAllColumns } from '@/components/schema-diagram/layout.ts'

/**
 * What the Designer's files (SVG, DIA, EPS) draw: the database's tables and keys, or, focused, those drawn. Never
 * a table of a snapshot compared with (it is gone) nor a candidate line (a guess): the boxes list the key columns
 * of the keys written, so a candidate's column is not listed as one.
 */
export function exportedDiagram({
  focused,
  shown,
  names,
  keys,
  allColumns,
}: {
  focused: boolean
  /** What the screen draws. */
  shown: { tables: readonly string[]; relations: readonly RelationDef[] }
  /** The database's tables, and its keys between them. */
  names: readonly string[]
  keys: readonly RelationDef[]
  /** Every column of a table, when the boxes list them all. */
  allColumns: (table: string) => readonly string[] | undefined
}): { tables: string[]; relations: RelationDef[]; columns: Map<string, string[]> } {
  const tables = focused ? shown.tables.filter((n) => names.includes(n)) : [...names]
  const relations = focused ? shown.relations.filter((r) => keys.includes(r)) : [...keys]
  const columns = new Map(tables.map((n) => [n, withAllColumns(boxColumns(n, relations), allColumns(n))]))
  return { tables, relations, columns }
}
