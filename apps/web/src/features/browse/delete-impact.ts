import type { DeleteImpact, DeleteImpactStep, RelationDef } from '@tsmyadmin/shared'
import type { OverlayStep, Tone } from '@/components/schema-diagram/overlay.ts'
import { relationKey } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.deleteImpact

/** How a followed key is lit: nothing when no row refers, since nothing happens along it. */
function toneOf(step: DeleteImpactStep): Tone | null {
  if (step.rows === 0) return null
  switch (step.action) {
    case 'cascade':
      return 'delete'
    case 'setNull':
    case 'setDefault':
      return 'nullify'
    default:
      return 'blocked'
  }
}

function sentence(step: DeleteImpactStep): string {
  if (step.rows === 0) return t.none(step.table, step.constraint)
  const cols = step.columns.join(', ')
  switch (step.action) {
    case 'cascade':
      return t.cascade(step.table, step.rows, step.constraint)
    case 'setNull':
      return t.setNull(step.table, step.rows, cols, step.constraint)
    case 'setDefault':
      return t.setDefault(step.table, step.rows, cols, step.constraint)
    default:
      return t.refuse(step.table, step.rows, step.constraint)
  }
}

/**
 * The story of a delete, one step per depth: the rows chosen, then every key followed at depth 1 at once, then
 * depth 2, … A table reached along several keys at one depth shows their rows added up.
 */
export function impactSteps(impact: DeleteImpact): OverlayStep[] {
  const start: OverlayStep = {
    text: t.start(impact.table, impact.rows),
    tables: [{ name: impact.table, tone: 'focus', badge: impact.rows.toLocaleString() }],
  }
  const depths = [...new Set(impact.steps.map((s) => s.depth))]
  return [
    start,
    ...depths.map((depth): OverlayStep => {
      const at = impact.steps.filter((s) => s.depth === depth)
      const lit = at.filter((s) => toneOf(s) !== null)
      const totals = new Map<string, number>()
      for (const s of lit) totals.set(s.table, (totals.get(s.table) ?? 0) + s.rows)
      return {
        text: `${t.depth(depth)}: ${at.map(sentence).join(' / ')}`,
        tables: lit.map((s) => ({
          name: s.table,
          tone: toneOf(s) ?? 'focus',
          badge: (totals.get(s.table) ?? s.rows).toLocaleString(),
        })),
        relations: lit.map((s) => ({
          key: relationKey({ table: s.table, name: s.constraint }),
          tone: toneOf(s) ?? 'focus',
        })),
        columns: lit.flatMap((s) => s.columns.map((column) => ({ table: s.table, column }))),
      }
    }),
  ]
}

/** The tables the story names, the deleted one first. */
export const impactTables = (impact: DeleteImpact): string[] => [impact.table, ...impact.steps.map((s) => s.table)]

/** The keys the walk followed, out of the namespace's foreign keys (two tables can be joined by more than one). */
export function impactRelations(impact: DeleteImpact, relations: readonly RelationDef[]): RelationDef[] {
  const followed = new Set(impact.steps.map((s) => relationKey({ table: s.table, name: s.constraint })))
  return relations.filter((r) => followed.has(relationKey(r)))
}
