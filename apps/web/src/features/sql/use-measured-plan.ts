import type { ExplainResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { analyzePlan } from '@/lib/queries.ts'

/** Where the measuring is: not asked, asked and waiting to be confirmed, or running. */
type MeasureStep = 'idle' | 'confirming' | 'running'

export interface MeasuredPlan {
  step: MeasureStep
  /** The plan as measured, the last time it was; null until then. */
  result: ExplainResult | null
  /** Why the last run failed (the measured plan before it is kept). */
  error: unknown
  ask: () => void
  cancel: () => void
  run: () => Promise<void>
}

/**
 * Measuring a statement's plan by running it: asked first (it runs on the server), then run once per press. A second
 * press while it runs does nothing (`useRef`: the state is a render late).
 */
export function useMeasuredPlan(db: string, schema: string | undefined, sql: string): MeasuredPlan {
  const [step, setStep] = useState<MeasureStep>('idle')
  const [result, setResult] = useState<ExplainResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const running = useRef(false)
  return {
    step,
    result,
    error,
    // Asked again or put away: why the last run failed is no longer what is shown.
    ask: () => {
      if (running.current) return
      setError(null)
      setStep('confirming')
    },
    cancel: () => {
      if (running.current) return
      setError(null)
      setStep('idle')
    },
    run: async () => {
      if (running.current) return
      running.current = true
      setStep('running')
      setError(null)
      try {
        setResult(await analyzePlan(db, schema, sql))
      } catch (err) {
        setError(err)
      } finally {
        running.current = false
        setStep('idle')
      }
    },
  }
}
