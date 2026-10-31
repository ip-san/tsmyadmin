import type { PlanNode } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'
import { planReads } from './plan-steps.ts'

/** A table read before the index and after it: how, how many rows, how long. */
export interface ReadChange {
  table: string
  before: PlanNode
  /** The same read after (the same table and name, the same how-many-th time); null where it is read no more. */
  after: PlanNode | null
}

/** The rows a measured read gave over all its runs (`rows` is per run); null where it was not measured. */
export const rowsRead = (n: PlanNode): number | null => (n.actual ? n.actual.rows * n.actual.loops : null)

/**
 * The reads of two plans of one statement, paired: each read before with the read of the same table (under the same
 * name, the same how-many-th time) after. The order may change, so they are paired by name, not by place.
 */
export function compareReads(before: PlanNode, after: PlanNode): ReadChange[] {
  const key = (n: PlanNode) => `${n.table}\0${n.alias ?? ''}`
  const later = new Map<string, PlanNode[]>()
  for (const r of planReads(after)) later.set(key(r.node), [...(later.get(key(r.node)) ?? []), r.node])
  return planReads(before).map((r) => ({
    table: r.node.table,
    before: r.node,
    after: later.get(key(r.node))?.shift() ?? null,
  }))
}

/** Whether a plan reads a table through this index (by name, as the servers write it; case aside, as MySQL may). */
export const usesIndex = (plan: PlanNode, table: string, index: string): boolean =>
  planReads(plan).some(
    (r) => r.node.table.toLowerCase() === table.toLowerCase() && r.node.index?.toLowerCase() === index.toLowerCase()
  )

/** Below this, a run is too short for a factor between two to mean anything. */
const SPEEDUP_FLOOR_MS = 1

/**
 * How many times faster the second run is than the first (below 1: slower); null where either is not timed, or took
 * under a millisecond (a factor of two such runs is noise).
 */
export function speedup(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before == null || after == null || Math.min(before, after) < SPEEDUP_FLOOR_MS) return null
  return before / after
}

/** How a measured read went, in a few words: through which index or in full, the rows and the time. */
export function readSaid(n: PlanNode): string {
  const p = locale.plan
  return p.trialRead(
    n.access === 'fullScan' ? null : n.index,
    rowsRead(n),
    n.actual?.ms == null ? null : p.duration(n.actual.ms)
  )
}
