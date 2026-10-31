import type { ExplainResult } from '@tsmyadmin/shared'
import { useState } from 'react'
import { useStoppableAnalyze } from './use-stoppable-analyze.ts'

/** Where the measuring is: not asked, asked and waiting to be confirmed, or running. */
type MeasureStep = 'idle' | 'confirming' | 'running'

export interface MeasuredPlan {
  step: MeasureStep
  /** The plan as measured, the last time it was; null until then. */
  result: ExplainResult | null
  /** Why the last run failed, or why a stop did not reach the server (the measured plan before it is kept). */
  error: unknown
  /** A stop was asked of the run, which has not ended yet. */
  stopping: boolean
  /** The last run was stopped on a press (the measured plan before it is kept). */
  stopped: boolean
  ask: () => void
  /** Puts the question away; while it runs, stops the run. */
  cancel: () => void
  run: () => Promise<void>
}

/**
 * Measuring a statement's plan by running it: asked first (it runs on the server), then run once per press, and
 * stoppable while it runs (`useStoppableAnalyze`).
 */
export function useMeasuredPlan(db: string, schema: string | undefined, sql: string): MeasuredPlan {
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<ExplainResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [stopped, setStopped] = useState(false)
  const analyze = useStoppableAnalyze(db, schema, sql)
  return {
    step: analyze.running ? 'running' : confirming ? 'confirming' : 'idle',
    result,
    error: error ?? analyze.stopError,
    stopping: analyze.stopping,
    stopped,
    // Asked again or put away: why the last run failed, or that it was stopped, is no longer what is shown.
    ask: () => {
      if (analyze.busy()) return
      setError(null)
      analyze.clearStopError()
      setStopped(false)
      setConfirming(true)
    },
    cancel: () => {
      if (analyze.busy()) return analyze.stop()
      setError(null)
      analyze.clearStopError()
      setStopped(false)
      setConfirming(false)
    },
    run: async () => {
      if (analyze.busy()) return
      setError(null)
      setStopped(false)
      // The question closes as the run ends, in the same update: the step goes from running to idle, never through
      // confirming (which would move the focus).
      const outcome = await analyze.run(() => setConfirming(false))
      if (outcome === null) return
      if (outcome.kind === 'done') setResult(outcome.result)
      else if (outcome.kind === 'stopped') setStopped(true)
      else setError(outcome.error)
    },
  }
}
