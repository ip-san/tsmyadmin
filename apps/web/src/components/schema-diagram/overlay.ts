import type { RelationDef } from '@tsmyadmin/shared'
import { autoLayout, boxColumns, boxHeight, type Point, withAllColumns } from './layout.ts'

/**
 * How a highlight is drawn. The names say what the delete impact meant by them, but each diagram gives a tone its
 * own meaning through its legend's labels (`DiagramLegend`'s `labels`): `index` is "added" when comparing with a
 * snapshot, `blocked` a deadlock on the lock wait diagram. What a tone draws (colour, width, dashes) never changes.
 */
export type Tone = 'delete' | 'nullify' | 'blocked' | 'index' | 'scan' | 'focus'

export const TONES: readonly Tone[] = ['focus', 'delete', 'nullify', 'blocked', 'index', 'scan']

/** One step of a story told on the diagram: what it lights up, and the sentence that says the same. */
export interface OverlayStep {
  text: string
  tables?: readonly { name: string; tone: Tone; badge?: string }[]
  /** By `relationKey`. */
  relations?: readonly { key: string; tone: Tone }[]
  columns?: readonly { table: string; column: string }[]
  /** Keys that flow while this step is the one shown (by `relationKey`): what the step did travelling along them. */
  flow?: readonly { key: string; direction: 'forward' | 'back' }[]
}

/** What the diagram draws over its boxes and lines. Anything not named here is drawn faint. */
export interface DiagramOverlay {
  tables: ReadonlyMap<string, { tone: Tone; badge?: string | undefined }>
  relations: ReadonlyMap<string, Tone>
  columns: ReadonlyMap<string, ReadonlySet<string>>
  /** A count or a word on a line, by `relationKey`: drawn at its middle whether line labels are shown or not. */
  relationBadges?: ReadonlyMap<string, string> | undefined
  /** False when the overlay only adds to the picture: nothing it does not name is drawn faint. */
  fade?: boolean | undefined
  /**
   * Keys drawn flowing, by `relationKey`: dashes running along the line from the table that refers to the one
   * referred to (`forward`), or the other way (`back`). Still for a reader who has asked for less motion.
   */
  flow?: ReadonlyMap<string, 'forward' | 'back'> | undefined
  /** The boxes come in column by column, and then the lines are drawn (unless the reader asked for less motion). */
  enter?: boolean | undefined
}

/**
 * The steps up to `index`, laid on top of each other: a step adds to what came before, so the picture at the last
 * step is the whole story. A later step that names the same table or key again wins. Only the step shown flows.
 */
export function overlayUpTo(steps: readonly OverlayStep[], index: number): DiagramOverlay {
  const tables = new Map<string, { tone: Tone; badge?: string | undefined }>()
  const relations = new Map<string, Tone>()
  const columns = new Map<string, Set<string>>()
  for (const step of steps.slice(0, Math.max(0, index + 1))) {
    for (const t of step.tables ?? []) tables.set(t.name, { tone: t.tone, badge: t.badge })
    for (const r of step.relations ?? []) relations.set(r.key, r.tone)
    for (const c of step.columns ?? []) {
      const set = columns.get(c.table) ?? new Set<string>()
      set.add(c.column)
      columns.set(c.table, set)
    }
  }
  const shown = steps[Math.min(index, steps.length - 1)]
  const flow = new Map((index >= 0 ? (shown?.flow ?? []) : []).map((f) => [f.key, f.direction] as const))
  return { tables, relations, columns, flow }
}

/**
 * A diagram of only the tables a story is about, laid out on its own: the database's whole Designer would bury
 * three tables among fifty. Keys are kept when both of their ends are drawn. `extraColumns` are listed in the
 * boxes after the key columns (an index's columns, say).
 */
export function diagramFor(
  involved: Iterable<string>,
  relations: readonly RelationDef[],
  extraColumns: ReadonlyMap<string, readonly string[]> = new Map()
): {
  tables: string[]
  relations: RelationDef[]
  columns: Map<string, string[]>
  positions: Record<string, Point>
} {
  const tables = [...new Set(involved)]
  const drawn = relations.filter((r) => tables.includes(r.table) && tables.includes(r.refTable))
  const columns = new Map(tables.map((n) => [n, withAllColumns(boxColumns(n, drawn), extraColumns.get(n))]))
  const positions = autoLayout(tables, drawn, undefined, (n) => boxHeight(columns.get(n)?.length ?? 0))
  return { tables, relations: drawn, columns, positions }
}

/**
 * Several overlays as one: later ones win where they name the same table, key or line, the columns of all are
 * listed, and the rest is drawn faint if any of them fades it. Nothing to lay over gives nothing.
 */
export function mergeOverlays(...overlays: readonly (DiagramOverlay | undefined)[]): DiagramOverlay | undefined {
  const given = overlays.filter((o): o is DiagramOverlay => o !== undefined)
  if (given.length === 0) return undefined
  const columns = new Map<string, Set<string>>()
  for (const o of given) {
    for (const [table, names] of o.columns) columns.set(table, new Set([...(columns.get(table) ?? []), ...names]))
  }
  return {
    tables: new Map(given.flatMap((o) => [...o.tables])),
    relations: new Map(given.flatMap((o) => [...o.relations])),
    columns,
    relationBadges: new Map(given.flatMap((o) => [...(o.relationBadges ?? [])])),
    fade: given.some((o) => o.fade !== false),
  }
}

/** How a box is outlined for a tone. Colour is never the only sign: the width and dashes differ as well. */
export const TONE_STROKE: Record<Tone, { className: string; width: number; dash?: string }> = {
  focus: { className: 'stroke-brand', width: 3 },
  delete: { className: 'stroke-critical', width: 2.5 },
  nullify: { className: 'stroke-chart-2', width: 2.5, dash: '6 3' },
  blocked: { className: 'stroke-ink', width: 3, dash: '2 3' },
  index: { className: 'stroke-chart-3', width: 2.5 },
  scan: { className: 'stroke-chart-2', width: 2.5, dash: '6 3' },
}

/** Faded while a story is shown, for what the story does not name. */
export const FAINT = 'opacity-30'
/** Highlights fade in and out, unless the reader has asked for less motion. */
export const FADE = 'transition-opacity duration-300 motion-reduce:transition-none'
