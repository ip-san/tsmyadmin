import { act, renderHook } from '@testing-library/react'
import type { ExplainResult } from '@tsmyadmin/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssumedCompare } from './use-assumed-compare.ts'
import type { AssumedPlan } from './use-assumed-plan.ts'
import { forecastHeld, useForecastStart } from './use-forecast-start.ts'

const answers: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
const hypotheticalPlan = vi.fn(
  (..._: unknown[]) =>
    new Promise((resolve, reject) => {
      answers.push({ resolve, reject })
    })
)
vi.mock('@/lib/queries.ts', () => ({ hypotheticalPlan: (...args: unknown[]) => hypotheticalPlan(...args) }))

const c = { table: 'logs', columns: ['level'], name: 'idx_logs_level', reason: 'filter' as const }
const planOf = (cost: number, extra: Partial<ExplainResult> = {}) =>
  ({ plan: { op: 'x', cost, children: [] }, raw: '', rawTruncated: false, ...extra }) as unknown as ExplainResult
const estimate = planOf(1000, { canAssume: true })
const noAssumed = (): AssumedPlan => ({
  candidate: null,
  result: null,
  running: false,
  error: null,
  assume: async () => undefined,
  clear: vi.fn(),
})
const noCompare: AssumedCompare = { rows: null, asked: null, running: false, compare: async () => undefined }
let start: ReturnType<typeof vi.fn<(c: unknown, f?: unknown) => void>>

beforeEach(() => {
  hypotheticalPlan.mockClear()
  answers.length = 0
  start = vi.fn<(c: unknown, f?: unknown) => void>()
})

const hook = (est: ExplainResult | undefined = estimate, assumed = noAssumed(), compared = noCompare) =>
  renderHook(() => useForecastStart('shop', undefined, 'SELECT 1', est, assumed, compared, start))

describe('forecastHeld', () => {
  it('takes the plan with it assumed, or its row alone in the comparison, and nothing of another index', () => {
    const assumed = { candidate: c, result: planOf(10, { assumed: ['idx_logs_level'] }) }
    expect(forecastHeld(c, estimate, assumed, { rows: null })).toEqual({ costBefore: 1000, costAfter: 10, used: true })
    const row = { indexes: [c], result: planOf(20), error: null }
    expect(forecastHeld(c, estimate, { candidate: null, result: null }, { rows: [row] })).toEqual({
      costBefore: 1000,
      costAfter: 20,
      used: false,
    })
    const other = { ...c, name: 'idx_other' }
    expect(forecastHeld(c, estimate, { candidate: other, result: planOf(10) }, { rows: null })).toBeUndefined()
    // All together is not this index's own forecast.
    const together = { indexes: [c, other], result: planOf(5), error: null }
    expect(forecastHeld(c, estimate, { candidate: null, result: null }, { rows: [together] })).toBeUndefined()
  })
})

describe('useForecastStart', () => {
  it('asks the server first where it can say, then opens the preview with what it said', async () => {
    const { result } = hook()
    await act(async () => {
      void result.current.start(c)
      void result.current.start(c)
    })
    expect(hypotheticalPlan).toHaveBeenCalledTimes(1)
    expect(result.current.forecasting).toBe(true)
    expect(start).not.toHaveBeenCalled()
    await act(async () => answers[0]?.resolve(planOf(10, { assumed: ['idx_logs_level'] })))
    expect(start).toHaveBeenCalledWith(c, { costBefore: 1000, costAfter: 10, used: true })
    expect(result.current.forecasting).toBe(false)
  })

  it('builds all the same, with no forecast, where asking fails', async () => {
    const { result } = hook()
    await act(async () => {
      void result.current.start(c)
    })
    await act(async () => answers[0]?.reject(new Error('no')))
    expect(start).toHaveBeenCalledWith(c, undefined)
  })

  it('asks nothing where the server cannot say, or where it was already said', async () => {
    const { result } = hook(planOf(1000, { canAssume: false }))
    await act(async () => result.current.start(c))
    expect(start).toHaveBeenLastCalledWith(c, undefined)
    const held = { ...noAssumed(), candidate: c, result: planOf(10, { assumed: ['idx_logs_level'] }) }
    const again = hook(estimate, held)
    await act(async () => again.result.current.start(c))
    expect(start).toHaveBeenLastCalledWith(c, { costBefore: 1000, costAfter: 10, used: true })
    expect(held.clear).toHaveBeenCalled()
    expect(hypotheticalPlan).not.toHaveBeenCalled()
  })

  it('opens no preview once the plan is closed while it asked', async () => {
    const { result, unmount } = hook()
    await act(async () => {
      void result.current.start(c)
    })
    unmount()
    await act(async () => answers[0]?.resolve(planOf(10)))
    expect(start).not.toHaveBeenCalled()
  })
})
