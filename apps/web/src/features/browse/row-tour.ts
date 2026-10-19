import type { Cell, ForeignKeyDef, RelationDef, TableSchema } from '@tsmyadmin/shared'
import { autoLayout, boxHeight } from '@/components/schema-diagram/layout.ts'
import type { diagramFor } from '@/components/schema-diagram/overlay.ts'
import { overlay, said, type TourScene, unique, whole } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import {
  columnComments,
  designSummary,
  keyIntent,
  keyReading,
  keyTuning,
  named,
  tableReading,
  tableTuning,
} from '@/lib/design-reading.ts'
import { isOpaqueCell } from '@/lib/format.ts'
import type { TableRef } from '@/lib/queries.ts'
import { type RowGraph, type RowNode, rowLabel } from './row-graph.ts'

const t = locale.rowTour

/** Rows of a table that refer to the first row drawn, per key: past them, the rest are counted. */
export const REFERRING_DRAWN = 3
/** Rows drawn in all: the picture stays readable, and the reads stay few. */
export const ROWS_DRAWN = 12
/** Values in a box: the keys that join it first, then the row's first columns. */
const VALUES_SHOWN = 6
/** A value longer than this is cut, in the box and in the words read out. */
const VALUE_CHARS = 24

/** A value as the tour shows it: NULL, a mark for what cannot be shown (binary, cut off), or the value, cut short. */
export function valueText(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (typeof cell === 'object' || isOpaqueCell(cell)) return '…'
  const s = String(cell)
  return s.length > VALUE_CHARS ? `${s.slice(0, VALUE_CHARS - 1)}…` : s
}

/**
 * The rows that refer to the first row cut to `REFERRING_DRAWN` per table and key (with what they refer to on), and
 * how many were left out of each, to be said rather than drawn.
 */
export function trimReferring(graph: RowGraph, rootId: string): { graph: RowGraph; left: Map<string, number> } {
  const kept = new Map<string, number>()
  const left = new Map<string, number>()
  const dropped = new Set<string>()
  for (const a of graph.arrows) {
    const from = graph.nodes.get(a.from)
    if (a.to !== rootId || !from) continue
    const group = groupKey(from.ref.table, a.label ?? '')
    const n = (kept.get(group) ?? 0) + 1
    kept.set(group, n)
    if (n > REFERRING_DRAWN) {
      dropped.add(a.from)
      left.set(group, (left.get(group) ?? 0) + 1)
    }
  }
  return {
    graph: {
      ...graph,
      nodes: new Map([...graph.nodes].filter(([id]) => !dropped.has(id))),
      arrows: graph.arrows.filter((a) => !dropped.has(a.from) && !dropped.has(a.to)),
    },
    left,
  }
}

const groupKey = (table: string, label: string) => JSON.stringify([table, label])

/** One arrow of the graph as a key between two rows: which row refers, which is referred to, and by what columns. */
interface Link {
  from: RowNode
  to: RowNode
  columns: readonly string[]
  refColumns: readonly string[]
  /** The foreign key itself, when the referring row's page names it. */
  key: ForeignKeyDef | undefined
}

/** The key an arrow followed: the referring row's own foreign key with those columns, to the other row's table. */
function linkOf(from: RowNode, to: RowNode, label: string): Link {
  const fk: ForeignKeyDef | undefined = from.page.foreignKeys.find(
    (k) => k.refTable === to.ref.table && k.columns.join(', ') === label
  )
  return {
    from,
    to,
    columns: fk?.columns ?? label.split(', '),
    refColumns: fk?.refColumns ?? (to.page.keyKind === 'pk' ? to.page.keyColumns : []),
    key: fk,
  }
}

/**
 * A row and the rows its foreign keys join it to, told so that it is understood more with each scene: the row, the
 * rows it refers to (the value that matches, marked on both), the rows that refer to it, the rows those refer to,
 * and what it all comes to: rows are joined by a value being the same. What was seen stays lit. Rows are boxes
 * named by their table and key, listing `column = value`; each key is a line from the value that refers to the one
 * referred to.
 */
export function rowTour(
  graph: RowGraph,
  rootId: string,
  left: ReadonlyMap<string, number> = new Map(),
  /** The definitions of the tables met, where read: what the design is read from. */
  schemaOf: (ref: TableRef) => TableSchema | undefined = () => undefined
): { diagram: ReturnType<typeof diagramFor>; scenes: TourScene[] } | undefined {
  const root = graph.nodes.get(rootId)
  if (!root) return undefined
  const ids = [rootId, ...[...graph.nodes.keys()].filter((id) => id !== rootId)].slice(0, ROWS_DRAWN)
  const nodes = ids.flatMap((id) => graph.nodes.get(id) ?? [])
  // Box names are the boxes' keys: two rows that read the same (no key, the same values) are told apart.
  const nameOf = new Map<string, string>()
  const taken = new Set<string>()
  for (const n of nodes) {
    const base = rowLabel(n).label
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`
    taken.add(name)
    nameOf.set(n.id, name)
  }
  const links = graph.arrows.flatMap((a) => {
    const from = graph.nodes.get(a.from)
    const to = graph.nodes.get(a.to)
    return from && to && nameOf.has(from.id) && nameOf.has(to.id) ? [linkOf(from, to, a.label ?? '')] : []
  })
  const line = (n: RowNode, column: string) => `${column} = ${valueText(n.values.get(column))}`
  const columns = new Map(
    nodes.map((n) => {
      const joined = links.flatMap((l) => (l.from === n ? l.columns : l.to === n ? l.refColumns : []))
      const keys = n.page.keyKind === 'pk' ? n.page.keyColumns : []
      const shown = unique([...keys, ...joined, ...n.values.keys()]).slice(0, Math.max(VALUES_SHOWN, keys.length))
      return [nameOf.get(n.id) ?? '', shown.map((c) => line(n, c))] as const
    })
  )
  const relations: RelationDef[] = links.map((l, i) => ({
    table: nameOf.get(l.from.id) ?? '',
    name: `k${i}`,
    columns: [line(l.from, l.columns[0] ?? '')],
    refNamespace: { database: '' },
    refTable: nameOf.get(l.to.id) ?? '',
    refColumns: [line(l.to, l.refColumns[0] ?? '')],
    onUpdate: null,
    onDelete: null,
  }))
  const tables = nodes.map((n) => nameOf.get(n.id) ?? '')
  const positions = autoLayout(tables, relations, undefined, (n) => boxHeight(columns.get(n)?.length ?? 0))
  const diagram = { tables, relations, columns, positions }

  const relationOf = (l: Link) => relations[links.indexOf(l)] as RelationDef
  const name = (n: RowNode) => nameOf.get(n.id) ?? ''
  const subOf = (n: RowNode) => rowLabel(n).sublabel
  // What was seen stays lit (fainter), so the picture grows: the scene's own rows and keys are the bright ones.
  const seenRows = new Set<string>([name(root)])
  const seenKeys: Link[] = []
  const scene = (title: string, text: string, rows: readonly RowNode[], keys: readonly Link[]): TourScene => {
    const now = new Set(rows.map(name))
    const lit = overlay({
      tables: [...unique([...seenRows, ...now])].map((x) => [x, now.has(x) ? 'focus' : 'index'] as const),
      relations: [...new Set([...seenKeys, ...keys])].map((l) => [relationOf(l), keys.includes(l) ? 'focus' : 'index']),
      flow: keys.map((l) => [relationOf(l), 'forward']),
      columns: keys.flatMap((l) => [
        [name(l.from), l.columns.slice(0, 1).map((c) => line(l.from, c))],
        [name(l.to), l.refColumns.slice(0, 1).map((c) => line(l.to, c))],
      ]),
    })
    for (const x of now) seenRows.add(x)
    seenKeys.push(...keys)
    return { title, text, frame: unique([name(root), ...now]), overlay: lit, pulse: [...now] }
  }
  const valuesSaid = (n: RowNode) => said((columns.get(name(n)) ?? []).slice(0, 3))
  const keyText = (cols: readonly string[], n: RowNode) => cols.map((c) => line(n, c)).join(', ')
  // A table as the words say it: with what its comment says it is.
  const called = (n: RowNode) => named(n.ref.table, schemaOf(n.ref)?.comment)
  // Why the rows are joined so (what the comments of its columns and the key say: how many, must it, what a delete
  // does), and where it may cost time. Read from the definitions of the two tables.
  const reading = (l: Link) => {
    const child = schemaOf(l.from.ref)
    if (!l.key) return {}
    return {
      notes: [
        ...columnComments(l.from.ref.table, l.columns, child),
        ...keyReading(called(l.from), called(l.to), keyIntent(l.key, child)),
      ],
      hints: keyTuning(l.key, l.from.ref.table, l.to.ref.table, child, schemaOf(l.to.ref)),
    }
  }

  const scenes: TourScene[] = [
    {
      ...scene(name(root), t.intro(called(root), valuesSaid(root)), [root], []),
      overlay: { ...overlay({ tables: [[name(root), 'focus']] }), enter: true },
      ...(() => {
        const own = schemaOf(root.ref)
        return own ? { notes: tableReading(own), hints: tableTuning(root.ref.table, own) } : {}
      })(),
    },
  ]
  const told = (s: TourScene, more: { notes?: readonly string[]; hints?: readonly string[] }) =>
    scenes.push({
      ...s,
      ...(more.notes && more.notes.length > 0 ? { notes: more.notes } : {}),
      ...(more.hints && more.hints.length > 0 ? { hints: more.hints } : {}),
    })
  // What the row refers to: one scene a key, the value that matches marked in both boxes.
  for (const l of links.filter((x) => x.from === root)) {
    told(
      scene(
        t.refersTitle(l.to.ref.table),
        t.refers(keyText(l.columns, root), l.to.ref.table, keyText(l.refColumns, l.to), subOf(l.to)),
        [root, l.to],
        [l]
      ),
      reading(l)
    )
  }
  // What refers to the row: one scene a table and key, with how many were left out.
  const referring = links.filter((x) => x.to === root && x.from !== root)
  for (const group of unique(referring.map((l) => groupKey(l.from.ref.table, l.columns.join(', '))))) {
    const keys = referring.filter((l) => groupKey(l.from.ref.table, l.columns.join(', ')) === group)
    const first = keys[0]
    if (!first) continue
    const more = left.get(group) ?? 0
    told(
      scene(
        t.referredTitle(first.from.ref.table, keys.length + more),
        t.referred(first.from.ref.table, keys.length, more, first.columns.join(', '), keyText(first.refColumns, root)),
        [root, ...keys.map((l) => l.from)],
        keys
      ),
      reading(first)
    )
  }
  // One step further: what the rows met so far refer to, a scene for each table and key.
  const farther = links.filter((l) => l.from !== root && l.to !== root)
  for (const group of unique(
    farther.map((l) => groupKey(`${l.from.ref.table}>${l.to.ref.table}`, l.columns.join(', ')))
  )) {
    const keys = farther.filter(
      (l) => groupKey(`${l.from.ref.table}>${l.to.ref.table}`, l.columns.join(', ')) === group
    )
    const first = keys[0]
    if (!first) continue
    told(
      scene(
        t.fartherTitle(first.from.ref.table, first.to.ref.table),
        t.farther(
          first.from.ref.table,
          first.to.ref.table,
          said(keys.map((l) => `${keyText(l.columns, l.from)} → ${subOf(l.to) ?? keyText(l.refColumns, l.to)}`))
        ),
        [...new Set([...keys.map((l) => l.from), ...keys.map((l) => l.to)])],
        keys
      ),
      reading(first)
    )
  }
  scenes.push({
    title: t.endTitle,
    text: t.end(unique(nodes.map((n) => n.ref.table)).length, nodes.length),
    frame: [],
    overlay: whole(false),
    pulse: [],
    notes: designSummary(
      links.flatMap((l) =>
        l.key
          ? [{ child: l.from.ref.table, parent: l.to.ref.table, intent: keyIntent(l.key, schemaOf(l.from.ref)) }]
          : []
      )
    ),
  })
  return { diagram, scenes }
}
