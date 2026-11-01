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

/** An index assumed, not built (HypoPG): the estimate as it is, the index, and whether the plan reads through it. */
export interface AssumedInput {
  before: ExplainResult
  index: IndexCandidate
  /** From the server's own names for the index assumed: a built index of the same name is not it. */
  used: boolean
}

/**
 * The table an index was suggested for, read before and after it: the read it was suggested for (a full read), and
 * the table's read after, through the index where it is (a table read twice, say joined to itself, may be read
 * through it once), else as it is read now. With the other tables read another way (a new index may change a join),
 * or read no more: by how, not by the time, which every run changes.
 */
function aroundIndex(
  before: PlanNode,
  after: PlanNode,
  { table, name }: IndexCandidate,
  said: (n: PlanNode) => string,
  notRead: string
) {
  const same = (n: PlanNode) => n.table?.toLowerCase() === table.toLowerCase()
  const changes = compareReads(before, after)
  const readsOf = (plan: PlanNode) => planReads(plan).flatMap((r) => (same(r.node) ? [r.node] : []))
  const was = readsOf(before)
  const wasRead = was.find((n) => n.access === 'fullScan') ?? was[0]
  const now = readsOf(after)
  const nowRead =
    now.find((n) => n.index?.toLowerCase() === name.toLowerCase()) ??
    changes.find((c) => c.before === wasRead)?.after ??
    now[0]
  const others = changes.flatMap((c) =>
    same(c.before) || (c.after && c.after.access === c.before.access && c.after.index === c.before.index)
      ? []
      : [`${c.table}: ${said(c.before)} → ${c.after ? said(c.after) : notRead}`]
  )
  return { was: wasRead ? said(wasRead) : null, now: nowRead ? said(nowRead) : null, others }
}

/** The before and after scenes of an index: the same table, lit as before and as after, its columns marked. */
function pair(
  before: PlanNode,
  after: PlanNode,
  table: string,
  columns: readonly string[],
  indexColumns: (table: string, index: string) => readonly string[],
  [was, now]: readonly [Pick<TourScene, 'title' | 'text'>, Pick<TourScene, 'title' | 'text' | 'notes'>]
): TourScene[] {
  const marked = [[table, columns] as const]
  return [
    {
      ...was,
      frame: [table],
      overlay: overlay({ tables: litOf(before, indexColumns), columns: marked }),
      pulse: [table],
    },
    {
      ...now,
      frame: [table],
      overlay: overlay({ tables: litOf(after, indexColumns), columns: marked }),
      pulse: [table],
    },
  ]
}

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
  const reads = aroundIndex(before.plan, after.plan, index, readSaid, t.trialNotRead)
  const used = usesIndex(after.plan, table, name)
  return [
    ...pair(before.plan, after.plan, table, columns, indexColumns, [
      { title: t.trialBeforeTitle, text: t.trialBefore(table, reads.was, name, columns) },
      { title: t.trialAfterTitle, text: t.trialAfter(table, reads.now, used), notes: reads.others },
    ]),
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

/** How a read is expected to go: through which index or in full, and the rows the plan expects. */
const expectedRead = (n: PlanNode) => p.assumeRead(n.access === 'fullScan' ? null : n.index, n.estRows)

/**
 * The chapter that shows an index assumed, not built: the table as the server plans to read it now, the same table
 * as it would with the index (the server's estimate), and the two estimated costs. Nothing is run: the cost is the
 * server's own unit, not a time, and only building and measuring says whether it is faster.
 */
export function assumedScenes(
  after: PlanNode,
  { before, index, used }: AssumedInput,
  indexColumns: (table: string, index: string) => readonly string[] = () => []
): TourScene[] {
  const { table, name, columns } = index
  const reads = aroundIndex(before.plan, after, index, expectedRead, t.trialNotRead)
  const [was, now] = [before.plan.cost, after.cost]
  return [
    ...pair(before.plan, after, table, columns, indexColumns, [
      { title: t.assumedBeforeTitle, text: t.assumedBefore(table, reads.was, name, columns) },
      { title: t.assumedAfterTitle, text: t.assumedAfter(table, reads.now, used), notes: reads.others },
    ]),
    {
      title: t.assumedCostTitle,
      text: was !== null && now !== null ? p.assumeCost(was, now) : t.assumedNoCost,
      frame: [],
      overlay: overlay({ tables: litOf(after, indexColumns) }),
      pulse: [],
      notes: [p.assumeNote],
      hints: [used ? t.assumedNext : p.assumeUnused(name)],
    },
  ]
}
