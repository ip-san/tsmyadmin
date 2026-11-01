import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compareSets, useAssumedCompare } from './use-assumed-compare.ts'

const answers: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
const hypotheticalPlan = vi.fn(
  (..._: unknown[]) =>
    new Promise((resolve, reject) => {
      answers.push({ resolve, reject })
    })
)
vi.mock('@/lib/queries.ts', () => ({ hypotheticalPlan: (...args: unknown[]) => hypotheticalPlan(...args) }))

const posts = { table: 'posts', columns: ['user_id'], name: 'idx_posts_user_id', reason: 'perRow' as const }
const users = { table: 'users', columns: ['email'], name: 'idx_users_email', reason: 'filter' as const }
const plan = (cost: number) => ({ plan: { op: 'x', cost, children: [] }, raw: '', rawTruncated: false, assumed: [] })
const sent = (i: number) => ((hypotheticalPlan.mock.calls[i]?.[3] ?? []) as { name: string }[]).map((x) => x.name)

beforeEach(() => {
  hypotheticalPlan.mockClear()
  answers.length = 0
})

describe('compareSets', () => {
  it('asks each candidate alone, then all together; one candidate is asked once', () => {
    expect(compareSets([posts, users])).toEqual([[posts], [users], [posts, users]])
    expect(compareSets([posts])).toEqual([[posts]])
  })
})

describe('useAssumedCompare', () => {
  it('asks one plan at a time, each alone and then all together, and keeps a failed one in its row', async () => {
    const { result } = renderHook(() => useAssumedCompare('shop', undefined, 'SELECT 1'))
    await act(async () => {
      void result.current.compare([posts, users])
      void result.current.compare([posts, users])
    })
    // One at a time, and the second press asks nothing.
    expect(hypotheticalPlan).toHaveBeenCalledTimes(1)
    expect(sent(0)).toEqual(['idx_posts_user_id'])
    await act(async () => answers[0]?.resolve(plan(10)))
    expect(sent(1)).toEqual(['idx_users_email'])
    await act(async () => answers[1]?.reject(new Error('no')))
    expect(sent(2)).toEqual(['idx_posts_user_id', 'idx_users_email'])
    expect(result.current.running).toBe(true)
    await act(async () => answers[2]?.resolve(plan(5)))
    expect(result.current.running).toBe(false)
    expect(result.current.rows?.map((r) => [r.result?.plan.cost ?? null, r.error ? 'failed' : null])).toEqual([
      [10, null],
      [null, 'failed'],
      [5, null],
    ])
  })

  it('drops what is still to come once put away, and asks no more', async () => {
    const { result } = renderHook(() => useAssumedCompare('shop', undefined, 'SELECT 1'))
    await act(async () => {
      void result.current.compare([posts, users])
    })
    act(() => result.current.clear())
    await act(async () => answers[0]?.resolve(plan(10)))
    expect(result.current.rows).toBeNull()
    expect(result.current.asked).toBeNull()
    expect(hypotheticalPlan).toHaveBeenCalledTimes(1)
  })
})
