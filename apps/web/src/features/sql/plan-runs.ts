import { z } from 'zod'

/** How many times a statement is measured in a row: each run is the server's own, and the times are set side by side. */
export const MEASURE_RUNS = [1, 3, 5] as const
export type MeasureRuns = (typeof MEASURE_RUNS)[number]
/** Where the count chosen is kept, in this browser. */
export const RUNS_PREF = 'plan.measureRuns'
export const runsSchema: z.ZodType<MeasureRuns> = z.union([z.literal(1), z.literal(3), z.literal(5)])

/** The times of the runs of one measuring, as said: how many, the median, the fastest and the slowest. */
export interface RunsSummary {
  count: number
  median: number
  min: number
  max: number
}

/**
 * The runs' times summed up, or null with none. The median, not the mean: the first run reads the rows from disk and
 * the next ones from the cache, and one slow run (another session's load) does not pull it.
 */
export function summarizeRuns(times: readonly number[]): RunsSummary | null {
  if (times.length === 0) return null
  const sorted = [...times].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  return { count: sorted.length, median, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 }
}

/** The time a measuring is compared by: the runs' median where there are runs, else the one run's own. */
export function runsTime(times: readonly number[], single: number | null | undefined): number | null {
  return summarizeRuns(times)?.median ?? single ?? null
}
