import type { ExplainResult, PlanNode } from '@tsmyadmin/shared'
import type { Tone } from '@/components/schema-diagram/overlay.ts'
import { overlay, type TourScene } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { compareReads, readSaid, speedup, usesIndex } from './plan-compare.ts'
import type { IndexCandidate } from './plan-index.ts'
import { planReads, planSteps } from './plan-steps.ts'

const t = locale.planTour
const p = locale.plan

/** An index tried on the statement: the run before it was made, and the index. The plan told is the run after. */
export interface TrialInput {
  before: ExplainResult
  index: IndexCandidate
}

type Lit = readonly (readonly [string, Tone, string])[]

/** Each table of a plan lit as it is last read: by how (an index as its badge, or "full"). */
function litOf(plan: PlanNode, indexColumns: (table: string, index: string) => readonly string[]): Lit {
  const lit = new Map<string, readonly [Tone, string]>()
  for (const step of planSteps(planReads(plan), indexColumns))
    for (const x of step.tables ?? []) lit.set(x.name, [x.tone, x.badge ?? p.full])
  return [...lit].map(([name, [tone, badge]]) => [name, tone, badge] as const)
}

const timeOf = (ms: number | null | undefined) => (ms == null ? null : p.duration(ms))

/**
 * The chapter that shows an index working: the table read before it (lit as then, with the index's columns marked
 * where it goes), the same table read after (lit as now: the tone and the badge change under the eye), and the two
 * runs' times. Each run is measured once, and the second may find the rows cached: said with the times.
 */
export function trialScenes(
  after: { plan: PlanNode; ms: number | null },
  { before, index }: TrialInput,
  indexColumns: (table: string, index: string) => readonly string[] = () => []
): TourScene[] {
  const { table, name, columns } = index
  const same = (n: PlanNode) => n.table?.toLowerCase() === table.toLowerCase()
  const changes = compareReads(before.plan, after.plan)
  const mine = changes.find((c) => same(c.before))
  const used = usesIndex(after.plan, table, name)
  const marked = [[table, columns] as const]
  // The other tables whose reads changed too: a new index may change the order or the way of a join.
  const others = changes.flatMap((c) =>
    c === mine || !c.after || readSaid(c.before) === readSaid(c.after)
      ? []
      : [`${c.table}: ${readSaid(c.before)} → ${readSaid(c.after)}`]
  )
  return [
    {
      title: t.trialBeforeTitle,
      text: t.trialBefore(table, mine ? readSaid(mine.before) : null, name, columns),
      frame: [table],
      overlay: overlay({ tables: litOf(before.plan, indexColumns), columns: marked }),
      pulse: [table],
    },
    {
      title: t.trialAfterTitle,
      text: t.trialAfter(table, mine?.after ? readSaid(mine.after) : null, used),
      frame: [table],
      overlay: overlay({ tables: litOf(after.plan, indexColumns), columns: marked }),
      pulse: [table],
      notes: others,
    },
    {
      title: t.trialTimeTitle,
      text: p.trialTotal(timeOf(before.measured?.ms), timeOf(after.ms), speedup(before.measured?.ms, after.ms)),
      frame: [],
      overlay: overlay({ tables: litOf(after.plan, indexColumns) }),
      pulse: [],
      notes: [t.trialHonest],
      hints: [used ? t.trialWriteCost : p.trialUnused(name)],
    },
  ]
}
