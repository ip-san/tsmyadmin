import type { ExplainResult } from '@tsmyadmin/shared'
import { overlay, type TourScene, unique } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import type { IndexCandidate } from './plan-index.ts'
import { aroundIndex, expectedRead, litOf } from './plan-tour-trial.ts'
import type { CompareRow } from './use-assumed-compare.ts'

const t = locale.planTour
const p = locale.plan

/** The candidates compared without building any (HypoPG): the estimate as it is, and the rows the server gave. */
export interface CompareInput {
  before: ExplainResult
  rows: readonly CompareRow[]
}

/** The candidates of the rows, once each (in the order asked). */
export function compareCandidates({ rows }: CompareInput): IndexCandidate[] {
  const seen = new Map<string, IndexCandidate>()
  for (const c of rows.flatMap((r) => r.indexes)) if (!seen.has(c.name)) seen.set(c.name, c)
  return [...seen.values()]
}

/** What the chapter tells: how many candidates were estimated each alone, and how many all together (0: not). */
export function compareTold({ rows }: CompareInput): { alone: number; together: number } {
  const estimated = rows.filter((r) => r.result)
  return {
    alone: estimated.filter((r) => r.indexes.length === 1).length,
    together: estimated.find((r) => r.indexes.length > 1)?.indexes.length ?? 0,
  }
}

const usedIn = (row: CompareRow, name: string) => row.result?.assumed?.includes(name) ?? false
const costLine = (before: number | null, after: number | null) =>
  before !== null && after !== null ? p.assumeCost(before, after) : t.assumedNoCost

/**
 * The chapter of the candidates compared: the plan as it is with every candidate's columns marked, then each
 * candidate assumed alone (its table, read as the server expects with it, beside how it is read now, and the costs),
 * then all of them together (every candidate's table, and which the server would use). Estimates only: none is built,
 * and the cost is the server's unit, not a time. Not a ranking: candidates on different tables may help together.
 * A row the server could not estimate is named, not told.
 */
export function compareScenes(
  input: CompareInput,
  indexColumns: (table: string, index: string) => readonly string[] = () => []
): TourScene[] {
  const { before, rows } = input
  const candidates = compareCandidates(input)
  const marked = candidates.map((c) => [c.table, c.columns] as const)
  const tables = unique(candidates.map((c) => c.table))
  const failed = rows.flatMap((r) =>
    r.result ? [] : [r.indexes.length === 1 ? (r.indexes[0]?.name ?? '') : t.compareAllTitle]
  )
  const told = compareTold(input)
  const scenes: TourScene[] = [
    {
      title: t.compareOpenTitle,
      text: t.compareOpen(told.alone, told.together, before.plan.cost),
      frame: tables,
      overlay: overlay({ tables: litOf(before.plan, indexColumns), columns: marked }),
      pulse: tables,
      notes: [p.compareNote, ...(failed.length > 0 ? [t.compareFailedNote(failed)] : [])],
    },
  ]
  for (const row of rows) {
    const after = row.result?.plan
    if (!after) continue
    const [one] = row.indexes
    if (row.indexes.length === 1 && one) {
      const used = usedIn(row, one.name)
      const reads = aroundIndex(before.plan, after, one, expectedRead, t.trialNotRead)
      scenes.push({
        title: t.compareOneTitle(one.name),
        text: t.compareOne(one.table, reads.was, reads.now, used),
        frame: [one.table],
        overlay: overlay({ tables: litOf(after, indexColumns), columns: [[one.table, one.columns]] }),
        pulse: [one.table],
        notes: [costLine(before.plan.cost, after.cost), ...reads.others],
        ...(used ? {} : { hints: [p.assumeUnused(one.name)] }),
      })
      continue
    }
    const used = row.indexes.filter((c) => usedIn(row, c.name)).map((c) => c.name)
    const unused = row.indexes.filter((c) => !usedIn(row, c.name)).map((c) => c.name)
    const lit = unique(row.indexes.filter((c) => usedIn(row, c.name)).map((c) => c.table))
    scenes.push({
      title: t.compareAllTitle,
      text: t.compareAll(used, unused),
      frame: tables,
      overlay: overlay({ tables: litOf(after, indexColumns), columns: marked }),
      pulse: lit,
      notes: [costLine(before.plan.cost, after.cost)],
      ...(unused.length > 0 && used.length > 0 ? { hints: [t.compareUnusedHint(unused)] } : {}),
    })
  }
  return scenes
}
