import type { RelationDef } from '@tsmyadmin/shared'
import { autoLayout, boxColumns, boxHeight, type Point, withAllColumns } from './layout.ts'

/** What a highlight says about a table or a key: the legend lists the same words. */
export type Tone = 'delete' | 'nullify' | 'blocked' | 'index' | 'scan' | 'focus'

export const TONES: readonly Tone[] = ['focus', 'delete', 'nullify', 'blocked', 'index', 'scan']

/** One step of a story told on the diagram: what it lights up, and the sentence that says the same. */
export interface OverlayStep {
  text: string
  tables?: readonly { name: string; tone: Tone; badge?: string }[]
  /** By `relationKey`. */
  relations?: readonly { key: string; tone: Tone }[]
  columns?: readonly { table: string; column: string }[]
}

/** What the diagram draws over its boxes and lines. Anything not named here is drawn faint. */
export interface DiagramOverlay {
  tables: ReadonlyMap<string, { tone: Tone; badge?: string | undefined }>
  relations: ReadonlyMap<string, Tone>
  columns: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * The steps up to `index`, laid on top of each other: a step adds to what came before, so the picture at the last
 * step is the whole story. A later step that names the same table or key again wins.
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
  return { tables, relations, columns }
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
