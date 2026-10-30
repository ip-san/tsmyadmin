import type { PlanNode } from '@tsmyadmin/shared'

/** How far apart the rows expected and the rows given must be, either way, to be called a misestimate. */
export const MISESTIMATE_RATIO = 10
/** Below this many rows on both sides, a gap is noise: 3 rows instead of 1 changes no plan. */
const MISESTIMATE_FLOOR = 100
/** A step that took this share of the run, or more, is where the time went. */
const HEAVY_SHARE = 0.5
/** A run shorter than this is too quick for its shares to mean anything (a cold cache weighs more than the plan). */
const HEAVY_FLOOR_MS = 10

export interface Misestimate {
  expected: number
  actual: number
  /** How many times more (or fewer) rows came than were expected, rounded. */
  factor: number
  more: boolean
}

/**
 * Where a measured step gave rows far from what was expected: both per run of the step (the estimate is per run on
 * every server, and so is the measured average). Null where the step was not measured, never ran, or is close.
 */
export function misestimate(node: PlanNode): Misestimate | null {
  const a = node.actual
  if (!a || a.loops === 0 || node.estRows === null) return null
  const [expected, actual] = [node.estRows, a.rows]
  if (Math.max(expected, actual) < MISESTIMATE_FLOOR) return null
  const ratio = Math.max(expected, actual) / Math.max(Math.min(expected, actual), 1)
  if (ratio < MISESTIMATE_RATIO) return null
  return {
    expected: Math.round(expected),
    actual: Math.round(actual),
    factor: Math.round(ratio),
    more: actual > expected,
  }
}

/**
 * The share of the run a step took, as a whole percent, where it is the most of it (`HEAVY_SHARE`) and the run was
 * long enough to tell (`HEAVY_FLOOR_MS`). A step's time counts the steps under it (MySQL, PostgreSQL): a table read
 * is a leaf, so its time is its own.
 */
export function heavyShare(node: PlanNode, totalMs: number | null | undefined): number | null {
  const share = shareOf(node, totalMs)
  return share !== null && share >= HEAVY_SHARE * 100 ? share : null
}

/**
 * The share of the run a step took, as a whole percent (never past 100: MariaDB times a table and the run apart),
 * where the run was long enough to tell (`HEAVY_FLOOR_MS`). Null where either is not timed.
 */
export function shareOf(node: PlanNode, totalMs: number | null | undefined): number | null {
  const ms = node.actual?.ms
  if (ms == null || totalMs == null || totalMs < HEAVY_FLOOR_MS) return null
  return Math.min(100, Math.round((ms / totalMs) * 100))
}
