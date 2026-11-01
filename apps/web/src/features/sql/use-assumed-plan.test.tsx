import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssumedPlan } from './use-assumed-plan.ts'

let answer: (v: unknown) => void
const hypotheticalPlan = vi.fn(
  (..._: unknown[]) =>
    new Promise((resolve) => {
      answer = resolve
    })
)
vi.mock('@/lib/queries.ts', () => ({ hypotheticalPlan: (...args: unknown[]) => hypotheticalPlan(...args) }))

const candidate = { table: 'logs', columns: ['level'], name: 'idx_logs_level', reason: 'filter' as const }
const plan = { plan: { op: 'x', children: [] }, raw: '', rawTruncated: false, assumed: ['idx_logs_level'] }

beforeEach(() => {
  hypotheticalPlan.mockClear()
})

describe('useAssumedPlan', () => {
  it('asks once for two presses in the same frame, before the state says it runs', async () => {
    const { result } = renderHook(() => useAssumedPlan('shop', undefined, 'SELECT * FROM logs'))
    await act(async () => {
      void result.current.assume(candidate)
      void result.current.assume(candidate)
    })
    expect(hypotheticalPlan).toHaveBeenCalledTimes(1)
    // Put away while it runs: not taken, the answer still lands.
    act(() => result.current.clear())
    await act(async () => answer(plan))
    expect(result.current.result).toEqual(plan)
    expect(result.current.candidate).toEqual(candidate)
    expect(result.current.running).toBe(false)
  })

  it('forgets the index asked for when the server refuses, so the plan as it is stays', async () => {
    hypotheticalPlan.mockImplementationOnce(async () => {
      throw new Error('no such column')
    })
    const { result } = renderHook(() => useAssumedPlan('shop', undefined, 'SELECT * FROM logs'))
    await act(() => result.current.assume(candidate))
    expect(result.current.candidate).toBeNull()
    expect(result.current.error).toBeInstanceOf(Error)
    // Asked again: the error goes.
    let again: Promise<void> = Promise.resolve()
    act(() => {
      again = result.current.assume(candidate)
    })
    expect(result.current.error).toBeNull()
    await act(async () => {
      answer(plan)
      await again
    })
    expect(result.current.result).toEqual(plan)
  })
})
