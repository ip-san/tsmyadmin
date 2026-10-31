import type { ExplainResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { analyzePlan, mutations } from '@/lib/queries.ts'

/** Where the measuring is: not asked, asked and waiting to be confirmed, or running. */
type MeasureStep = 'idle' | 'confirming' | 'running'

export interface MeasuredPlan {
  step: MeasureStep
  /** The plan as measured, the last time it was; null until then. */
  result: ExplainResult | null
  /** Why the last run failed (the measured plan before it is kept). */
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
 * stoppable while it runs (the server's cancel, as for a script of the SQL tab: the run is registered under an id of
 * its own). A second press while it runs, or a second stop, does nothing (`useRef`: the state is a render late).
 */
export function useMeasuredPlan(db: string, schema: string | undefined, sql: string): MeasuredPlan {
  const [step, setStep] = useState<MeasureStep>('idle')
  const [result, setResult] = useState<ExplainResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const running = useRef<string | null>(null)
  const stop = useRef(false)
  const stopRun = (id: string) => {
    if (stop.current) return
    stop.current = true
    setStopping(true)
    mutations.cancelSql(db, id).catch((err: unknown) => {
      // The stop did not reach the server: the run goes on, and can be stopped again.
      if (running.current !== id) return
      stop.current = false
      setStopping(false)
      setError(err)
    })
  }
  return {
    step,
    result,
    error,
    stopping,
    stopped,
    // Asked again or put away: why the last run failed, or that it was stopped, is no longer what is shown.
    ask: () => {
      if (running.current) return
      setError(null)
      setStopped(false)
      setStep('confirming')
    },
    cancel: () => {
      if (running.current) return stopRun(running.current)
      setError(null)
      setStopped(false)
      setStep('idle')
    },
    run: async () => {
      if (running.current) return
      const id = crypto.randomUUID()
      running.current = id
      stop.current = false
      setStep('running')
      setError(null)
      setStopped(false)
      try {
        setResult(await analyzePlan(db, schema, sql, id))
      } catch (err) {
        // Stopped on a press: said as such, not as a failure.
        if (stop.current) setStopped(true)
        else setError(err)
      } finally {
        running.current = null
        stop.current = false
        setStopping(false)
        setStep('idle')
      }
    },
  }
}
