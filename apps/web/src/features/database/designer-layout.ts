import type { Dialect, Namespace, RelationDef } from '@tsmyadmin/shared'

export interface Point {
  x: number
  y: number
}

export const BOX_WIDTH = 200
export const HEADER_HEIGHT = 28
export const ROW_HEIGHT = 20
const GAP_X = 80
const GAP_Y = 32
const MARGIN = 16

/** Keys between two tables drawn on this diagram: a key into another database or schema has nothing to point at. */
export function drawnRelations(
  relations: readonly RelationDef[],
  dialect: Dialect,
  ns: Namespace,
  tables: readonly string[]
): RelationDef[] {
  // PostgreSQL reports the schema of every referenced table; a page opened without one is showing public.
  const schema = dialect === 'postgres' ? (ns.schema ?? 'public') : undefined
  const home = (other: Namespace) => other.database === ns.database && other.schema === schema
  return relations.filter((r) => home(r.refNamespace) && tables.includes(r.table) && tables.includes(r.refTable))
}

/**
 * The columns a table's box lists: those its own keys use, then those other tables' keys point at. Listing every
 * column would take a structure read per table; these are the ones the lines attach to.
 */
export function boxColumns(table: string, relations: readonly RelationDef[]): string[] {
  const out: string[] = []
  const add = (c: string) => {
    if (!out.includes(c)) out.push(c)
  }
  for (const r of relations) if (r.table === table) r.columns.forEach(add)
  for (const r of relations) if (r.refTable === table) r.refColumns.forEach(add)
  return out
}

export const boxHeight = (columns: number) => HEADER_HEIGHT + Math.max(columns, 1) * ROW_HEIGHT

/**
 * A layered starting layout: tables nothing else is referenced from sit in the first column, and a table goes one
 * column to the right of the furthest table it references, so lines mostly run right to left. Cycles (including a
 * key back to an earlier table) are cut where they are met.
 */
export function autoLayout(tables: readonly string[], relations: readonly RelationDef[]): Record<string, Point> {
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const rankOf = (table: string): number => {
    const known = rank.get(table)
    if (known !== undefined) return known
    if (visiting.has(table)) return 0
    visiting.add(table)
    const refs = relations.filter((r) => r.table === table && r.refTable !== table).map((r) => rankOf(r.refTable) + 1)
    visiting.delete(table)
    const value = Math.max(0, ...refs)
    rank.set(table, value)
    return value
  }
  const out: Record<string, Point> = {}
  const nextY: number[] = []
  for (const table of tables) {
    const r = rankOf(table)
    const y = nextY[r] ?? MARGIN
    out[table] = { x: MARGIN + r * (BOX_WIDTH + GAP_X), y }
    nextY[r] = y + boxHeight(boxColumns(table, relations).length) + GAP_Y
  }
  return out
}

/** Where a column's row meets the side of its box nearer to `towardsX`. */
function anchor(box: Point, columns: readonly string[], column: string, towardsX: number): Point {
  const row = Math.max(columns.indexOf(column), 0)
  const centre = box.x + BOX_WIDTH / 2
  return {
    x: towardsX < centre ? box.x : box.x + BOX_WIDTH,
    y: box.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2,
  }
}

/**
 * A box's columns when every column is listed: the ones its keys use first (so the lines still attach at the top),
 * then the rest in table order.
 */
export function withAllColumns(keyColumns: readonly string[], all: readonly string[] | undefined): string[] {
  if (!all) return [...keyColumns]
  return [...keyColumns, ...all.filter((c) => !keyColumns.includes(c))]
}

/** The curve of one key between the two boxes it joins, from its column's row to the referenced column's row. */
export function relationPath(
  r: RelationDef,
  at: (table: string) => Point,
  columnsOf: (table: string) => readonly string[]
): string {
  const from = at(r.table)
  const to = at(r.refTable)
  const a = anchor(from, columnsOf(r.table), r.columns[0] ?? '', to.x + BOX_WIDTH / 2)
  const b = anchor(to, columnsOf(r.refTable), r.refColumns[0] ?? '', from.x + BOX_WIDTH / 2)
  const bend = Math.max(40, Math.abs(b.x - a.x) / 2)
  const ax = a.x === from.x ? a.x - bend : a.x + bend
  const bx = b.x === to.x ? b.x - bend : b.x + bend
  return `M ${a.x} ${a.y} C ${ax} ${a.y}, ${bx} ${b.y}, ${b.x} ${b.y}`
}
