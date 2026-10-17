import type { RelationDef, SnapshotDiff } from '@tsmyadmin/shared'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import type { DiagramOverlay, Tone } from '@/components/schema-diagram/overlay.ts'
import { locale } from '@/config/locale-screens.ts'

const t = locale.designer.compare

/**
 * The diagram of the schema now and of what a snapshot had that is gone: the tables removed since are drawn again,
 * with the keys the snapshot recorded for them, and every table is lit by what happened to it (added, removed,
 * changed). Tables that did not change carry no tone, so they are drawn faint. Views are not drawn, as elsewhere.
 *
 * The comparison is the server's, made just now; the list of tables may be a moment older (a migration runs outside
 * this page), so a removed table still in that list is drawn as removed all the same.
 */
export function compareDiagram(
  diff: SnapshotDiff,
  tables: readonly string[],
  relations: readonly RelationDef[]
): { tables: string[]; relations: RelationDef[]; overlay: DiagramOverlay } {
  const kinds = new Map(diff.shape.tables.map((x) => [x.name, x.kind]))
  // Views (and sequences) are not drawn, here as on the Designer.
  const gone = diff.removed.map((e) => e.name).filter((n) => kinds.get(n) === 'table')
  const goneSet = new Set(gone)
  const drawn = [...tables, ...gone.filter((n) => !tables.includes(n))]
  const recorded = diff.shape.relations.filter(
    (r) => (goneSet.has(r.table) || goneSet.has(r.refTable)) && drawn.includes(r.table) && drawn.includes(r.refTable)
  )
  const known = new Set(relations.map(relationKey))
  const all = [...relations, ...recorded.filter((r) => !known.has(relationKey(r)))]
  const goneKeys = all.filter((r) => goneSet.has(r.table) || goneSet.has(r.refTable))
  const lit = new Map<string, { tone: Tone; badge: string }>()
  for (const e of diff.added) if (tables.includes(e.name)) lit.set(e.name, { tone: 'index', badge: t.added })
  for (const e of diff.changed) if (tables.includes(e.name)) lit.set(e.name, { tone: 'nullify', badge: t.changed })
  for (const n of gone) lit.set(n, { tone: 'blocked', badge: t.removed })
  return {
    tables: drawn,
    relations: all,
    overlay: {
      tables: lit,
      relations: new Map(goneKeys.map((r) => [relationKey(r), 'blocked' as const])),
      columns: new Map(),
    },
  }
}
