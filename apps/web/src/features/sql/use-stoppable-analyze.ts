import type { ExplainResult } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { analyzePlan, mutations } from '@/lib/queries.ts'

/** How a measured run ended: with its plan, failing, or stopped on a press (as the server says). */
type AnalyzeOutcome = { kind: 'done'; result: ExplainResult } | { kind: 'failed'; error: unknown } | { kind: 'stopped' }

export interface StoppableAnalyze {
  running: boolean
  /** A stop was asked of the run, which has not ended yet. */
  stopping: boolean
  /** Why the last stop did not reach the server (the run went on). */
  stopError: unknown
  /** Runs the statement to measure it; null where a run is going already (a second press). */
  run: () => Promise<AnalyzeOutcome | null>
  /** Stops the run going, once however often pressed; nothing where none is. */
  stop: () => void
}

/**
 * One statement measured by running it, stoppable while it runs: the run is registered under an id of its own, and a
 * stop is the server's cancel, as for a script of the SQL tab. Whether it was stopped is what the server says (a run
 * that had just ended, or failed of its own, is not called stopped); a stop that did not take can be asked again.
 * Closed while it runs, the run is stopped too. A second press is caught by `useRef` (the state is a render late).
 */
export function useStoppableAnalyze(db: string, schema: string | undefined, sql: string): StoppableAnalyze {
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<unknown>(null)
  const current = useRef<string | null>(null)
  /** The stop asked of the run: whether the server stopped it (false where it had ended, or could not be reached). */
  const stopAsked = useRef<Promise<boolean> | null>(null)
  useEffect(
    () => () => {
      if (current.current) void mutations.cancelSql(db, current.current).catch(() => undefined)
    },
    [db]
  )
  return {
    running,
    stopping,
    stopError,
    run: async () => {
      if (current.current) return null
      const id = crypto.randomUUID()
      current.current = id
      stopAsked.current = null
      setRunning(true)
      setStopError(null)
      try {
        return { kind: 'done', result: await analyzePlan(db, schema, sql, id) }
      } catch (error) {
        return stopAsked.current && (await stopAsked.current) ? { kind: 'stopped' } : { kind: 'failed', error }
      } finally {
        current.current = null
        stopAsked.current = null
        setRunning(false)
        setStopping(false)
      }
    },
    stop: () => {
      const id = current.current
      if (!id || stopAsked.current) return
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
