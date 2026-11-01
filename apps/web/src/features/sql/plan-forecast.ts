import type { ExplainResult } from '@tsmyadmin/shared'

/**
 * What trying an index without building it said, kept for the index built from it: the planner's estimated cost
 * without and with it, and whether the plan would read through it.
 */
export interface Forecast {
  costBefore: number | null
  costAfter: number | null
  used: boolean
}

/** How the run with the index built bore out the forecast: used or not, as said or not. */
export type ForecastVerdict = 'used' | 'unused' | 'notUsed' | 'usedAnyway'

/** The forecast of an index assumed (by the name it was asked under), from the estimate as it is and the one with it. */
export function forecastOf(estimate: ExplainResult, assumed: ExplainResult, name: string): Forecast {
  return {
    costBefore: estimate.plan.cost,
    costAfter: assumed.plan.cost,
    used: assumed.assumed?.includes(name) ?? false,
  }
}

/** Whether the server used the index built as the forecast said it would. */
export function forecastVerdict(forecast: Forecast, used: boolean): ForecastVerdict {
  if (forecast.used) return used ? 'used' : 'notUsed'
  return used ? 'usedAnyway' : 'unused'
}
