import type { DiagnosticReport } from '@tsmyadmin/shared'

/** How many statements the history keeps: the oldest fall off the end. */
export const RECENT_KEPT = 300

interface RecentStatement {
  /** Unique within the history. */
  id: number
  /** When it ran: the log's own time (MySQL), or when this page noticed it (PostgreSQL). */
  time: string
  statement: string
  /** How many times it ran (a PostgreSQL step covers every call between two reads). */
  runs: number
}

export interface RecentHistory {
  entries: readonly RecentStatement[]
  /** MySQL: the newest logged time seen, so the next read asks only for what ran after it. */
  since: string | undefined
  /** PostgreSQL: the call count of each statement at the last read, to subtract from the next. Null before the first. */
  counts: ReadonlyMap<string, number> | null
  nextId: number
}

export const EMPTY_HISTORY: RecentHistory = { entries: [], since: undefined, counts: null, nextId: 1 }

/** The clock time of `2026-09-21 10:00:00.123456`, or of a Date. */
export const clockTime = (time: string) => time.slice(11, 23)
/** A Date in the shape of a logged time, in this browser's own time zone (the clock the reader is looking at). */
function stamp(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const ms = String(at.getMilliseconds()).padStart(3, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${ms}`
}

/**
 * Folds one read of the `recentStatements` report into the history, newest first.
 *
 * MySQL's report is the general log's rows after `since`, so they are added as they are. PostgreSQL's is a running
 * call count per statement (pg_stat_statements): the first read only becomes the baseline, and every later one adds
 * the statements whose count grew, by how much. A count that fell means the statistics were reset: a new baseline.
 */
export function foldReport(
  history: RecentHistory,
  report: DiagnosticReport,
  now: Date,
  kept = RECENT_KEPT
): RecentHistory {
  if (report.status !== 'ok') return history
  let nextId = history.nextId
  const fresh: RecentStatement[] = []
  if (report.columns[0] === 'time') {
    // Newest first, as the log is read: a statement of the same instant as `since` is not read twice (it is `>`).
    for (const [time, statement] of report.rows) {
      if (time && statement) fresh.push({ id: nextId++, time, statement, runs: 1 })
    }
    return {
      ...history,
      entries: [...fresh, ...history.entries].slice(0, kept),
      since: fresh[0]?.time ?? history.since,
      nextId,
    }
  }
  const counts = new Map<string, number>()
  for (const [statement, runs] of report.rows) if (statement) counts.set(statement, Number(runs) || 0)
  if (history.counts !== null) {
    const time = stamp(now)
    for (const [statement, runs] of counts) {
      const before = history.counts.get(statement) ?? 0
      if (runs > before) fresh.push({ id: nextId++, time, statement, runs: runs - before })
    }
  }
  return { ...history, entries: [...fresh, ...history.entries].slice(0, kept), counts, nextId }
}
