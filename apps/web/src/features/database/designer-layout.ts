import type { DesignerView, Dialect, Namespace, RelationDef } from '@tsmyadmin/shared'

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

/** Room for a line of text inside a box, with `pad` left free on each side. */
export const textRoom = (pad: number) => BOX_WIDTH - 2 * pad

const NARROW = new Set([..."iljtfrI.,:;'!|()[]/\\- "])
/** How wide one character is, in em: a guess that errs wide, since a name that fits the guess must fit the box. */
function glyphEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // Japanese and other full-width characters are one em wide (table names in the language of the business).
  if (code >= 0x2e80) return 1
  if (NARROW.has(ch)) return 0.36
  if (ch === 'm' || ch === 'w' || ch === 'M' || ch === 'W') return 0.92
  if (ch >= 'A' && ch <= 'Z') return 0.72
  return 0.6
}

/**
 * The text cut with an ellipsis where it would run out of `room` pixels at `size`: a long table or column name
 * would otherwise be drawn across the edge of its box (and, in an export, out of the picture). Widths are an
 * estimate (an SVG has no way to measure text before it is drawn), so the cut is a little early rather than late.
 */
export function fitText(text: string, size: number, room: number, bold = false): string {
  const em = (t: string) => [...t].reduce((n, ch) => n + glyphEm(ch), 0) * size * (bold ? 1.1 : 1)
  if (em(text) <= room) return text
  const chars = [...text]
  while (chars.length > 1 && em(`${chars.join('')}…`) > room) chars.pop()
  return `${chars.join('')}…`
}

export const boxHeight = (columns: number, compact = false) =>
  compact ? HEADER_HEIGHT : HEADER_HEIGHT + Math.max(columns, 1) * ROW_HEIGHT

export const DEFAULT_VIEW: DesignerView = {
  compact: false,
  snap: false,
  lineStyle: 'curve',
  lineLabels: false,
  showLines: true,
}

export const GRID = 20
/** A point on the grid nearest to it. */
export const snapToGrid = (p: Point): Point => ({ x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID })

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
function anchor(box: Point, columns: readonly string[], column: string, towardsX: number, compact: boolean): Point {
  const row = Math.max(columns.indexOf(column), 0)
  const centre = box.x + BOX_WIDTH / 2
  return {
    x: towardsX < centre ? box.x : box.x + BOX_WIDTH,
    // A compact box has no rows: its lines meet the header.
    y: compact ? box.y + HEADER_HEIGHT / 2 : box.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2,
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

/** How one key is drawn: a Bézier curve, or a run of straight segments. */
export type Route =
  | { kind: 'curve'; from: Point; control1: Point; control2: Point; to: Point }
  | { kind: 'lines'; points: Point[] }

/** The line of one key between the two boxes it joins, from its column's row to the referenced column's row. */
export function relationRoute(
  r: RelationDef,
  at: (table: string) => Point,
  columnsOf: (table: string) => readonly string[],
  style: DesignerView['lineStyle'] = 'curve',
  compact = false
): Route {
  const box = at(r.table)
  const refBox = at(r.refTable)
  const a = anchor(box, columnsOf(r.table), r.columns[0] ?? '', refBox.x + BOX_WIDTH / 2, compact)
  const b = anchor(refBox, columnsOf(r.refTable), r.refColumns[0] ?? '', box.x + BOX_WIDTH / 2, compact)
  if (style === 'straight') return { kind: 'lines', points: [a, b] }
  const bend = Math.max(40, Math.abs(b.x - a.x) / 2)
  const out1 = { x: a.x === box.x ? a.x - bend : a.x + bend, y: a.y }
  const out2 = { x: b.x === refBox.x ? b.x - bend : b.x + bend, y: b.y }
  // Right angles: out of the side of the box, across at the middle, and into the other side.
  if (style === 'polyline') {
    const midX = (out1.x + out2.x) / 2
    return { kind: 'lines', points: [a, out1, { x: midX, y: a.y }, { x: midX, y: b.y }, out2, b] }
  }
  return { kind: 'curve', from: a, control1: out1, control2: out2, to: b }
}

/** The same line as an SVG path. */
export function relationPath(
  r: RelationDef,
  at: (table: string) => Point,
  columnsOf: (table: string) => readonly string[],
  style: DesignerView['lineStyle'] = 'curve',
  compact = false
): string {
  const route = relationRoute(r, at, columnsOf, style, compact)
  if (route.kind === 'lines') return route.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  return `M ${route.from.x} ${route.from.y} C ${route.control1.x} ${route.control1.y}, ${route.control2.x} ${route.control2.y}, ${route.to.x} ${route.to.y}`
}

/** The middle of a route, where its label goes. */
export function routeMiddle(route: Route): Point {
  if (route.kind === 'curve') {
    const { from: a, control1: b, control2: c, to: d } = route
    return { x: (a.x + 3 * b.x + 3 * c.x + d.x) / 8, y: (a.y + 3 * b.y + 3 * c.y + d.y) / 8 }
  }
  const at = Math.floor((route.points.length - 1) / 2)
  const from = route.points[at] as Point
  const to = route.points[at + 1] as Point
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
}

/** The text of a key's label: the columns it joins. */
export const relationLabel = (r: RelationDef) => `${r.columns.join(', ')} → ${r.refColumns.join(', ')}`

/** What every export format draws: the tables, the keys between them, where the boxes are and what each lists. */
export interface DiagramInput {
  tables: readonly string[]
  relations: readonly RelationDef[]
  positions: Readonly<Record<string, Point>>
  columns: ReadonlyMap<string, readonly string[]>
  /** Columns marked as their table's display column. */
  display?: ReadonlyMap<string, string> | undefined
  /** How the diagram is drawn; the default view when omitted. */
  view?: DesignerView | undefined
}
