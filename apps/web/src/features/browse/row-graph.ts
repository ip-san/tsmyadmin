import type { BrowseOptions, BrowseResult, Cell, Filter, InputCell, Namespace } from '@tsmyadmin/shared'
import { chosenDisplayColumn } from '@/lib/display-column.ts'
import { isOpaqueCell } from '@/lib/format.ts'
import type { TableRef } from '@/lib/queries.ts'
import { displayColumn } from './fk-labels.ts'

/** Rows read for one table that refers to a row; more are counted, and opened in the table itself. */
export const REFERRING_SHOWN = 10

/** One row of the graph, with what its table says about keys (from the page it was read in). */
export interface RowNode {
  id: string
  ref: TableRef
  values: ReadonlyMap<string, Cell>
  page: Pick<BrowseResult, 'columns' | 'keyColumns' | 'keyKind' | 'foreignKeys' | 'referencedBy'>
}

/** Where to read the rows one step away, and how the arrow between is labelled and pointed. */
export interface RowStep {
  ref: TableRef
  options: BrowseOptions
  /** The rows found refer to the node (`in`), or the node refers to them (`out`). */
  direction: 'in' | 'out'
  label: string
}

const refOf = (ns: Namespace, table: string): TableRef => ({ db: ns.database, schema: ns.schema, table })

/** The row's own columns, without the hidden ctid that a ctid table carries last. */
function columnsOf(page: RowNode['page']): string[] {
  const names = page.columns.map((c) => c.name)
  return page.keyKind === 'ctid' ? names.slice(0, -1) : names
}

/** A row read from a page, named by its table and key (all its values where the table has no key to name it by). */
export function rowNode(ref: TableRef, page: RowNode['page'], row: readonly Cell[]): RowNode {
  const names = columnsOf(page)
  const values = new Map(names.map((n, i) => [n, row[i] ?? null] as const))
  const keyNames = page.keyKind === 'pk' ? page.keyColumns : names
  const id = JSON.stringify([ref.db, ref.schema ?? '', ref.table, keyNames.map((n) => values.get(n) ?? null)])
  return { id, ref, values, page }
}

/** A value that can be looked up again: not NULL, not binary, not cut off. */
const lookupable = (cell: Cell | undefined): cell is InputCell =>
  cell !== null && cell !== undefined && !isOpaqueCell(cell)

/** `column = value` for every pair, or null when any value cannot be looked up (a NULL in a key refers to nothing). */
function equals(columns: readonly string[], values: readonly (Cell | undefined)[]): Filter[] | null {
  const filters: Filter[] = []
  for (const [i, column] of columns.entries()) {
    const value = values[i]
    if (!lookupable(value)) return null
    filters.push({ column, op: 'eq', value })
  }
  return filters
}

/**
 * The reads one step away from a row: the row each of its foreign keys refers to, and the rows of each table that
 * refer to it (at most `REFERRING_SHOWN`, with the total counted). Keys of several columns are matched column by column.
 */
export function rowSteps(node: RowNode): RowStep[] {
  const out = node.page.foreignKeys.flatMap((fk): RowStep[] => {
    const filters = equals(
      fk.refColumns,
      fk.columns.map((c) => node.values.get(c))
    )
    if (!filters) return []
    return [
      {
        ref: refOf(fk.refNamespace, fk.refTable),
        options: { offset: 0, limit: 1, sort: [], filters },
        direction: 'out',
        label: fk.columns.join(', '),
      },
    ]
  })
  const referring = node.page.referencedBy.flatMap((rk): RowStep[] => {
    const filters = equals(
      rk.fromColumns,
      rk.columns.map((c) => node.values.get(c))
    )
    if (!filters) return []
    return [
      {
        ref: refOf(rk.fromNamespace, rk.fromTable),
        options: { offset: 0, limit: REFERRING_SHOWN, sort: [], filters },
        direction: 'in',
        label: rk.fromColumns.join(', '),
      },
    ]
  })
  return [...out, ...referring]
}

const text = (cell: Cell | undefined): string =>
  cell === null || cell === undefined ? 'NULL' : typeof cell === 'object' ? '…' : String(cell)

/** What a row's box says: its table and key, and the value of its display column where the table has one. */
export function rowLabel(node: RowNode): { label: string; sublabel: string | undefined } {
  const keyNames = node.page.keyKind === 'pk' ? node.page.keyColumns : []
  const key = keyNames.map((n) => `${n}=${text(node.values.get(n))}`).join(', ')
  const shown = displayColumn(
    node.page.columns,
    keyNames[0] ?? '',
    chosenDisplayColumn({ db: node.ref.db, schema: node.ref.schema, table: node.ref.table }) ?? undefined
  )
  return {
    label: key ? `${node.ref.table} ${key}` : node.ref.table,
    sublabel: shown ? text(node.values.get(shown)) : undefined,
  }
}
