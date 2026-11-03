import type { ExplainResult } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { analyzePlan, mutations } from '@/lib/queries.ts'

/** The runs that ended: the last one's plan (the tree shown), and every run's time. */
export interface MeasuredRuns {
  result: ExplainResult
  times: number[]
}

/**
 * How a measuring ended: with its runs, failing, or stopped on a press (as the server says, or between two runs).
 * Stopped after some runs ended, those are kept (`partial`).
 */
type AnalyzeOutcome =
  | ({ kind: 'done' } & MeasuredRuns)
  | { kind: 'failed'; error: unknown }
  | { kind: 'stopped'; partial?: MeasuredRuns }

/** Which run of a series is going (1-based), and of how many. */
export interface RunProgress {
  at: number
  of: number
}

export interface StoppableAnalyze {
  running: boolean
  /** Which run of a series of more than one is going; null otherwise. */
  progress: RunProgress | null
  /** A stop was asked of the run, which has not ended yet. */
  stopping: boolean
  /** Why the last stop did not reach the server (the run went on). */
  stopError: unknown
  /** A run is going (read from a ref: true from the press, not a render later). */
  busy: () => boolean
  /**
   * Runs the statement `count` times in a row to measure it; null where a run is going already (a second press).
   * `onEnd` is called as the series ends, in the same update as `running` turns false.
   */
  run: (count?: number, onEnd?: () => void) => Promise<AnalyzeOutcome | null>
  /** Stops the run going, and the series with it, once however often pressed; nothing where none is. */
  stop: () => void
  /** Puts away why the last stop did not reach the server. */
  clearStopError: () => void
}

/**
 * One statement measured by running it, stoppable while it runs: the run is registered under an id of its own, and a
 * stop is the server's cancel, as for a script of the SQL tab. Whether it was stopped is what the server says (a run
 * that had just ended, or failed of its own, is not called stopped); a stop that did not take can be asked again.
 * Closed while it runs, the run is stopped too. A second press is caught by `useRef` (the state is a render late).
 */
export function useStoppableAnalyze(db: string, schema: string | undefined, sql: string): StoppableAnalyze {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<unknown>(null)
  const current = useRef<string | null>(null)
  /** The stop asked of the run: whether the server stopped it (false where it had ended, or could not be reached). */
  const stopAsked = useRef<Promise<boolean> | null>(null)
  /** No further run of the series starts: stopped on a press (whatever the server said of the run going), or closed. */
  const ending = useRef(false)
  useEffect(
    () => () => {
      ending.current = true
      if (current.current) void mutations.cancelSql(db, current.current).catch(() => undefined)
    },
    [db]
  )
  return {
    running,
    progress,
    stopping,
    stopError,
    busy: () => current.current !== null,
    clearStopError: () => setStopError(null),
    run: async (count = 1, onEnd) => {
      if (current.current) return null
      // Held from the press, between the runs too: a second press is caught all along.
      const first = crypto.randomUUID()
      current.current = first
      stopAsked.current = null
      ending.current = false
      setRunning(true)
      setStopError(null)
      const times: number[] = []
      let last: ExplainResult | null = null
      const partial = () => (last ? { partial: { result: last, times } } : {})
      try {
        for (let at = 1; at <= count; at++) {
          // Stopped between two runs (the one going had just ended), or closed: the next does not start.
          if (ending.current) return { kind: 'stopped', ...partial() }
          // Each run its own id: a stop reaches the one going, never one that ended.
          const id = at === 1 ? first : crypto.randomUUID()
          current.current = id
          setProgress(count > 1 ? { at, of: count } : null)
          try {
            last = await analyzePlan(db, schema, sql, id)
          } catch (error) {
            return stopAsked.current && (await stopAsked.current)
              ? { kind: 'stopped', ...partial() }
              : { kind: 'failed', error }
          }
          if (last.measured?.ms != null) times.push(last.measured.ms)
        }
        return last ? { kind: 'done', result: last, times } : { kind: 'stopped' }
      } finally {
        current.current = null
        stopAsked.current = null
        onEnd?.()
        setRunning(false)
        setStopping(false)
        setProgress(null)
      }
    },
    stop: () => {
      const id = current.current
      if (!id || stopAsked.current) return
      // The series ends here, whatever the server says of the run going.
      ending.current = true
      setStopping(true)
      setStopError(null)
      const asked = mutations.cancelSql(db, id).then(
        (r) => r.cancelled,
        (err: unknown) => {
          if (current.current === id) setStopError(err)
          return false
        }
      )
      stopAsked.current = asked
      void asked.then((cancelled) => {
        // Not stopped (it had just ended, or the stop did not reach the server): it can be stopped again.
        if (cancelled || current.current !== id) return
        stopAsked.current = null
        setStopping(false)
      })
    },
  }
}
