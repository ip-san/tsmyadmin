import type { DesignerView, Dialect, Namespace, RelationDef } from '@tsmyadmin/shared'
import { homeNamespace } from '@/lib/home-namespace.ts'

export interface Point {
  x: number
  y: number
}

export const BOX_WIDTH = 200
export const HEADER_HEIGHT = 28
export const ROW_HEIGHT = 20
/**
 * Room under a box for its note (one line of small text): a layout that draws notes counts it in the box's height,
 * so the gap to the box below stays whole, also once snapped to the grid.
 */
export const NOTE_ROOM = 18
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
  const home = homeNamespace(dialect, ns)
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

/** Room for a line of text inside a box of `width`, with `pad` left free on each side. */
export const textRoom = (pad: number, width = BOX_WIDTH) => width - 2 * pad

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

/** The estimated width of `text` in pixels at `size` (see `glyphEm`). */
export const textWidth = (text: string, size: number, bold = false): number =>
  [...text].reduce((n, ch) => n + glyphEm(ch), 0) * size * (bold ? 1.1 : 1)

/** The widest a box grows to fit its names: beyond it a name is cut with an ellipsis, as in a fixed-width box. */
export const MAX_BOX_WIDTH = 480

/**
 * How wide a box is. Fixed, or (`view.fitWidth`) as wide as its table name and the columns it lists need, so nothing
 * is cut, up to `MAX_BOX_WIDTH`. Sized for the SVG's 12 px text and 8 px padding, which is the largest any export uses.
 */
export function makeWidthOf(o: {
  tables: readonly string[]
  columns: ReadonlyMap<string, readonly string[]>
  display?: ReadonlyMap<string, string> | undefined
  view?: DesignerView | undefined
}): (table: string) => number {
  const view = o.view ?? DEFAULT_VIEW
  if (!view.fitWidth) return () => BOX_WIDTH
  const widths = new Map(
    o.tables.map((name) => {
      const labels = view.compact ? [] : (o.columns.get(name) ?? []).map((c) => columnLabel(o.display, name, c))
      const need = Math.max(textWidth(name, 12, true), ...labels.map((l) => textWidth(l, 12)))
      return [name, Math.min(MAX_BOX_WIDTH, Math.max(BOX_WIDTH, Math.ceil(need + 2 * 8)))] as const
    })
  )
  return (table) => widths.get(table) ?? BOX_WIDTH
}

/** A column's text in a box: the table's display column is marked. */
export const columnLabel = (display: ReadonlyMap<string, string> | undefined, table: string, column: string) =>
  display?.get(table) === column ? `◆ ${column}` : column

/**
 * The text cut with an ellipsis where it would run out of `room` pixels at `size`: a long table or column name
 * would otherwise be drawn across the edge of its box (and, in an export, out of the picture). Widths are an
 * estimate (an SVG has no way to measure text before it is drawn), so the cut is a little early rather than late.
 */
export function fitText(text: string, size: number, room: number, bold = false): string {
  const em = (t: string) => textWidth(t, size, bold)
  if (em(text) <= room) return text
  const chars = [...text]
  while (chars.length > 1 && em(`${chars.join('')}…`) > room) chars.pop()
  return `${chars.join('')}…`
}

/** How tall a box is, and with `note`, the line under it as well (what a layout keeps clear of the next box). */
export const boxHeight = (columns: number, compact = false, note = false) =>
  (compact ? HEADER_HEIGHT : HEADER_HEIGHT + Math.max(columns, 1) * ROW_HEIGHT) + (note ? NOTE_ROOM : 0)

export const DEFAULT_VIEW: DesignerView = {
  compact: false,
  snap: false,
  fitWidth: false,
  lineStyle: 'curve',
  lineLabels: false,
  comments: false,
  showLines: true,
}

export const GRID = 20
/** A point on the grid nearest to it. */
export const snapToGrid = (p: Point): Point => ({ x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID })

/** Every position moved to the grid. */
export const snapAll = (positions: Readonly<Record<string, Point>>): Record<string, Point> =>
  Object.fromEntries(Object.entries(positions).map(([name, p]) => [name, snapToGrid(p)]))

/** An arrow of a graph: `from` refers to (or waits on, or points at) `to`. */
export interface GraphEdge {
  from: string
  to: string
}

/**
 * A layered layout of any graph: nodes nothing points from sit in the first column, and a node goes one column to the
 * right of the furthest node it points at, so arrows mostly run right to left. Cycles (including an arrow back to an
 * earlier node) are cut where they are met; `findCycles` is what reports them.
 */
export function layeredLayout(
  ids: readonly string[],
  edges: readonly GraphEdge[],
  widthOf: (id: string) => number,
  heightOf: (id: string) => number,
  /** Room between columns: wider where the arrows carry labels. */
  gapX = GAP_X
): Record<string, Point> {
  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const rankOf = (id: string): number => {
    const known = rank.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const refs = edges.filter((e) => e.from === id && e.to !== id).map((e) => rankOf(e.to) + 1)
    visiting.delete(id)
    const value = Math.max(0, ...refs)
    rank.set(id, value)
    return value
  }
  // A column is as wide as its widest box, so wider boxes push the columns after them to the right.
  const columnWidth: number[] = []
  for (const id of ids) {
    const r = rankOf(id)
    columnWidth[r] = Math.max(columnWidth[r] ?? 0, widthOf(id))
  }
  const columnX: number[] = []
  let x = MARGIN
  columnWidth.forEach((w, r) => {
    columnX[r] = x
    x += (w ?? BOX_WIDTH) + gapX
  })
  const out: Record<string, Point> = {}
  const nextY: number[] = []
  for (const id of ids) {
    const r = rankOf(id)
    const y = nextY[r] ?? MARGIN
    out[id] = { x: columnX[r] ?? MARGIN, y }
    nextY[r] = y + heightOf(id) + GAP_Y
  }
  return out
}

/** Names in reading order: session 9 before session 10. */
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

/**
 * The groups of nodes that reach each other along the arrows (the strongly connected components with more than one
 * node, and a node with an arrow to itself), each group's names sorted, the groups in the order their first node is
 * listed. Where `layeredLayout` cuts a cycle to place it, this names it: a deadlock is such a group of sessions, and
 * every session of it is caught, however many cycles run through it (Tarjan's algorithm, not one cycle per back-edge).
 */
export function cyclicGroups(ids: readonly string[], edges: readonly GraphEdge[]): string[][] {
  const next = new Map<string, string[]>()
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  const visit = (id: string) => {
    index.set(id, index.size)
    low.set(id, index.get(id) ?? 0)
    stack.push(id)
    onStack.add(id)
    for (const to of next.get(id) ?? []) {
      if (!index.has(to)) {
        visit(to)
        low.set(id, Math.min(low.get(id) ?? 0, low.get(to) ?? 0))
      } else if (onStack.has(to)) low.set(id, Math.min(low.get(id) ?? 0, index.get(to) ?? 0))
    }
    if (low.get(id) !== index.get(id)) return
    const group: string[] = []
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member)
      group.push(member)
      if (member === id) break
    }
    if (group.length > 1 || (next.get(id) ?? []).includes(id)) groups.push(group.sort(byName))
  }
  for (const id of ids) if (!index.has(id)) visit(id)
  const order = new Map(ids.map((id, i) => [id, i]))
  const first = (g: string[]) => Math.min(...g.map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER))
  return groups.sort((a, b) => first(a) - first(b))
}

/**
 * A layered starting layout of tables: tables nothing else is referenced from sit in the first column, and a table
 * goes one column to the right of the furthest table it references, so lines mostly run right to left.
 */
export function autoLayout(
  tables: readonly string[],
  relations: readonly RelationDef[],
  widthOf: (table: string) => number = () => BOX_WIDTH,
  heightOf: (table: string) => number = (table) => boxHeight(boxColumns(table, relations).length)
): Record<string, Point> {
  return layeredLayout(
    tables,
    relations.map((r) => ({ from: r.table, to: r.refTable })),
    widthOf,
    heightOf
  )
}

/** Where a column's row meets the side of its box nearer to `towardsX`. */
function anchor(
  box: Point,
  width: number,
  columns: readonly string[],
  column: string,
  towardsX: number,
  compact: boolean
): Point {
  const row = Math.max(columns.indexOf(column), 0)
  const centre = box.x + width / 2
  return {
    x: towardsX < centre ? box.x : box.x + width,
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
  compact = false,
  widthOf: (table: string) => number = () => BOX_WIDTH
): Route {
  const box = at(r.table)
  const refBox = at(r.refTable)
  const w = widthOf(r.table)
  const refW = widthOf(r.refTable)
  const a = anchor(box, w, columnsOf(r.table), r.columns[0] ?? '', refBox.x + refW / 2, compact)
  const b = anchor(refBox, refW, columnsOf(r.refTable), r.refColumns[0] ?? '', box.x + w / 2, compact)
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
  compact = false,
  widthOf: (table: string) => number = () => BOX_WIDTH
): string {
  const route = relationRoute(r, at, columnsOf, style, compact, widthOf)
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

/** Distinct per key: constraint names are unique within a table, not across the database. */
export const relationKey = (r: Pick<RelationDef, 'table' | 'name'>) => JSON.stringify([r.table, r.name])
