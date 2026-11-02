import type { ExplainResult } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { hypotheticalPlan } from '@/lib/queries.ts'
import { type Forecast, forecastOf } from './plan-forecast.ts'
import type { IndexCandidate } from './plan-index.ts'
import type { AssumedCompare } from './use-assumed-compare.ts'
import type { AssumedPlan } from './use-assumed-plan.ts'

export interface ForecastStart {
  /** The forecast is being asked for, before the preview opens. */
  forecasting: boolean
  /** Opens the preview of building `c`, with what the server expects of it where it can say (HypoPG). */
  start: (c: IndexCandidate) => Promise<void>
}

const same = (a: IndexCandidate, b: IndexCandidate) =>
  a.table === b.table && a.name === b.name && a.columns.join('\0') === b.columns.join('\0')

/**
 * What was already said of `c` without building it: the plan with it assumed, or its row alone in the comparison. The
 * same index by table, name and columns: a name may be another candidate's in an older list.
 */
export function forecastHeld(
  c: IndexCandidate,
  estimate: ExplainResult,
  assumed: Pick<AssumedPlan, 'candidate' | 'result'>,
  compared: Pick<AssumedCompare, 'rows'>
): Forecast | undefined {
  if (assumed.result && assumed.candidate && same(assumed.candidate, c))
    return forecastOf(estimate, assumed.result, c.name)
  const row = compared.rows?.find(
    (r) => r.indexes.length === 1 && r.indexes[0] !== undefined && same(r.indexes[0], c) && r.result
  )
  return row?.result ? forecastOf(estimate, row.result, c.name) : undefined
}

/**
 * Building an index from the plan, with its forecast kept to set beside the run: where the server can plan with an
 * index assumed (PostgreSQL with HypoPG), it is asked just before the preview opens, unless trying it without building
 * it already said. Asking is a plan, not a run; where it fails, the index is built all the same, with no forecast.
 */
export function useForecastStart(
  db: string,
  schema: string | undefined,
  sql: string,
  /** The plan estimated, as it is (absent until it is read). */
  estimate: ExplainResult | undefined,
  assumed: AssumedPlan,
  compared: AssumedCompare,
  start: (c: IndexCandidate, forecast?: Forecast) => void
): ForecastStart {
  const [forecasting, setForecasting] = useState(false)
  // The preview opens with the choices as they are once the forecast comes (writes stopped or not), not at the press.
  const latest = useRef(start)
  latest.current = start
  const busy = useRef(false)
  // The plan closed while it was asked: no preview opens on a page that is gone.
  const gone = useRef(false)
  useEffect(() => {
    gone.current = false
    return () => {
      gone.current = true
    }
  }, [])
  return {
    forecasting,
    start: async (c) => {
      if (busy.current) return
      const held = estimate ? forecastHeld(c, estimate, assumed, compared) : undefined
      assumed.clear()
      if (held || !estimate?.canAssume) {
        start(c, held)
        return
      }
      busy.current = true
      setForecasting(true)
      let said: Forecast | undefined
      try {
        const plan = await hypotheticalPlan(db, schema, sql, [{ table: c.table, columns: c.columns, name: c.name }])
        said = forecastOf(estimate, plan, c.name)
      } catch {
        // Not said (the server could not plan it now): built all the same, with nothing set beside the run.
      } finally {
        busy.current = false
        if (!gone.current) setForecasting(false)
      }
      if (!gone.current) latest.current(c, said)
    },
  }
}
