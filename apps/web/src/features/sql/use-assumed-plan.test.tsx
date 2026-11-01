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
    await act(async () => answer(plan))
    expect(result.current.result).toEqual(plan)
    expect(result.current.candidate).toEqual(candidate)
    expect(result.current.running).toBe(false)
  })

  it('drops the answer of an ask put away while it ran (measuring puts it away)', async () => {
    const { result } = renderHook(() => useAssumedPlan('shop', undefined, 'SELECT * FROM logs'))
    await act(async () => {
      void result.current.assume(candidate)
    })
    act(() => result.current.clear())
    expect(result.current.running).toBe(false)
    await act(async () => answer(plan))
    expect(result.current.result).toBeNull()
    expect(result.current.candidate).toBeNull()
  })

  it('takes a new ask at once after one was put away, before the old answer comes', async () => {
    const { result } = renderHook(() => useAssumedPlan('shop', undefined, 'SELECT * FROM logs'))
    await act(async () => {
      void result.current.assume(candidate)
    })
    const first = answer
    act(() => result.current.clear())
    const other = { ...candidate, columns: ['id'], name: 'idx_logs_id' }
    await act(async () => {
      void result.current.assume(other)
    })
    expect(hypotheticalPlan).toHaveBeenCalledTimes(2)
    // The old answer lands late: it neither shows nor lets the new ask's guard go.
    await act(async () => first(plan))
    expect(result.current.running).toBe(true)
    await act(async () => {
      void result.current.assume(other)
    })
    expect(hypotheticalPlan).toHaveBeenCalledTimes(2)
    await act(async () => answer({ ...plan, assumed: ['idx_logs_id'] }))
    expect(result.current.candidate).toEqual(other)
    expect(result.current.result).toEqual({ ...plan, assumed: ['idx_logs_id'] })
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
