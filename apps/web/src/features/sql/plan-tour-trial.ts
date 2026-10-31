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
  const readsOf = (plan: PlanNode) => planReads(plan).flatMap((r) => (same(r.node) ? [r.node] : []))
  // The read the index was suggested for (a full read), and the table's read after: through the index where it is
  // (a table read twice, say joined to itself, may be read through it once), else as it is read now.
  const was = readsOf(before.plan)
  const wasRead = was.find((n) => n.access === 'fullScan') ?? was[0]
  const now = readsOf(after.plan)
  const nowRead =
    now.find((n) => n.index?.toLowerCase() === name.toLowerCase()) ??
    changes.find((c) => c.before === wasRead)?.after ??
    now[0]
  const used = usesIndex(after.plan, table, name)
  const marked = [[table, columns] as const]
  // The other tables read another way too (a new index may change a join), or read no more: by how, not by the
  // time, which every run changes.
  const others = changes.flatMap((c) =>
    same(c.before) || (c.after && c.after.access === c.before.access && c.after.index === c.before.index)
      ? []
      : [`${c.table}: ${readSaid(c.before)} → ${c.after ? readSaid(c.after) : t.trialNotRead}`]
  )
  return [
    {
      title: t.trialBeforeTitle,
      text: t.trialBefore(table, wasRead ? readSaid(wasRead) : null, name, columns),
      frame: [table],
      overlay: overlay({ tables: litOf(before.plan, indexColumns), columns: marked }),
      pulse: [table],
    },
    {
      title: t.trialAfterTitle,
      text: t.trialAfter(table, nowRead ? readSaid(nowRead) : null, used),
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
