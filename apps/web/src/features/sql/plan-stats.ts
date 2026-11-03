import type { PlanNode } from '@tsmyadmin/shared'
import { type RowEstimates, rowsOf } from '@/lib/row-estimates.ts'
import { misestimate } from './plan-measure.ts'
import { type PlanRead, planReads } from './plan-steps.ts'

/** Below this many rows, a gap between two estimates is noise, not a sign. */
const STALE_FLOOR = 1000
/** How far apart the two estimates must be, either way, to be said. */
const STALE_RATIO = 2

/** A full read whose rows the plan and the table list estimate far apart. */
export interface StaleRead {
  table: string
  plan: number
  list: number
}

/**
 * Where the plan's rows for a whole table and the table list's estimate are far apart: one of the two counts is
 * old (PostgreSQL scales its count by the table's pages now; MySQL's list is cached apart from the optimizer's).
 * Only a full read with no condition, not split between workers (`Parallel …`: rows per worker): there the plan's
 * rows are the table's. Not in a plan that stops at a limit, to be safe: a server may count only the rows read
 * before it stops (PostgreSQL and MySQL 8.4 count the whole table; MySQL's format 1 has no step for the limit).
 */
export function staleRead(read: PlanRead, rows: RowEstimates | undefined, limited: boolean): StaleRead | null {
  const n = read.node
  if (limited || n.access !== 'fullScan' || n.detail || n.estRows === null || /^parallel /i.test(n.op)) return null
  const listed = rowsOf(rows, n.table)
  if (!listed || listed.counted) return null
  const [plan, list] = [Math.round(n.estRows), listed.n]
  if (Math.min(plan, list) < STALE_FLOOR || Math.max(plan, list) < STALE_RATIO * Math.min(plan, list)) return null
  return { table: n.table, plan, list }
}

/**
 * Why a table's statistics may be old: the plan and the table list far apart (`list`), or, once measured, a read of
 * it whose rows were far off the estimate (`measured`: old statistics, or columns whose values go together, which
 * taking them again does not mend).
 */
export type StatsSign =
  | ({ kind: 'list' } & StaleRead)
  | { kind: 'measured'; table: string; expected: number; actual: number }

/** The signs, one per table read (the run's first, where it was measured: what the server did, not what it thought). */
export function statsSigns(
  estimate: PlanNode,
  limited: boolean,
  measured: PlanNode | null,
  rows: RowEstimates | undefined
): StatsSign[] {
  const signs = new Map<string, StatsSign>()
  for (const read of measured ? planReads(measured) : []) {
    const off = misestimate(read.node)
    if (off && !signs.has(read.node.table))
      signs.set(read.node.table, {
        kind: 'measured',
        table: read.node.table,
        expected: off.expected,
        actual: off.actual,
      })
  }
  for (const read of planReads(estimate)) {
    const stale = staleRead(read, rows, limited)
    if (stale && !signs.has(stale.table)) signs.set(stale.table, { kind: 'list', ...stale })
  }
  return [...signs.values()]
}

/** The rows the plan expects of its first read of a table; null where it reads no such table (or says no rows). */
export function readRows(plan: PlanNode, table: string): number | null {
  const est = planReads(plan).find((r) => r.node.table === table)?.node.estRows
  return est === undefined || est === null ? null : Math.round(est)
}
