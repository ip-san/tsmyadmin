import type { ExplainResult } from '@tsmyadmin/shared'
import { useRef, useState } from 'react'
import { hypotheticalPlan } from '@/lib/queries.ts'
import type { IndexCandidate } from './plan-index.ts'

export interface AssumedPlan {
  /** The index the plan shown assumes, or is being planned with; null when none is. */
  candidate: IndexCandidate | null
  /** The plan with it assumed, once the server gave it. */
  result: ExplainResult | null
  running: boolean
  error: unknown
  /** Asks the server for the plan with this index assumed (once at a time). */
  assume: (c: IndexCandidate) => Promise<void>
  /** Back to the plan as it is. */
  clear: () => void
}

/**
 * Trying an index without building it: the server plans the statement as if it were there (PostgreSQL with HypoPG).
 * Nothing is written and nothing is run, so nothing is asked first and nothing is remembered: there is nothing to
 * drop afterwards.
 */
export function useAssumedPlan(db: string, schema: string | undefined, sql: string): AssumedPlan {
  const [candidate, setCandidate] = useState<IndexCandidate | null>(null)
  const [result, setResult] = useState<ExplainResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // A second press in the same frame: the state says running one render late.
  const busy = useRef(false)
  return {
    candidate,
    result,
    running,
    error,
    assume: async (c) => {
      if (busy.current) return
      busy.current = true
      setCandidate(c)
      setResult(null)
      setError(null)
      setRunning(true)
      try {
        setResult(await hypotheticalPlan(db, schema, sql, [{ table: c.table, columns: c.columns, name: c.name }]))
      } catch (e) {
        setCandidate(null)
        setError(e)
      } finally {
        busy.current = false
        setRunning(false)
      }
    },
    clear: () => {
      if (busy.current) return
      setCandidate(null)
      setResult(null)
      setError(null)
    },
  }
}
