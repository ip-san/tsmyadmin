import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStoppableAnalyze } from './use-stoppable-analyze.ts'

/** The run, held until a test ends it. */
let end: { done: (r: unknown) => void; fail: (err: Error) => void }
const analyzePlan = vi.fn(
  (..._: unknown[]) =>
    new Promise((done, fail) => {
      end = { done, fail }
    })
)
/** What the server says of a stop. */
let answer: () => Promise<{ cancelled: boolean }>
const cancelSql = vi.fn((_db: string, _id: string) => answer())

vi.mock('@/lib/queries.ts', () => ({
  analyzePlan: (...args: unknown[]) => analyzePlan(...args),
  mutations: { cancelSql: (...args: Parameters<typeof cancelSql>) => cancelSql(...args) },
}))

beforeEach(() => {
  analyzePlan.mockClear()
  cancelSql.mockClear()
  answer = async () => ({ cancelled: true })
})

const hook = () => renderHook(() => useStoppableAnalyze('shop', undefined, 'SELECT 1'))

describe('useStoppableAnalyze', () => {
  it('runs once however often pressed, under an id of its own', async () => {
    const { result } = hook()
    let first: Promise<unknown> = Promise.resolve()
    let second: Promise<unknown> = Promise.resolve()
    act(() => {
      first = result.current.run()
      second = result.current.run()
    })
    expect(await second).toBeNull()
    expect(result.current.busy()).toBe(true)
    expect(analyzePlan).toHaveBeenCalledTimes(1)
    expect(analyzePlan.mock.calls[0]?.[3]).toMatch(/^[0-9a-f-]{36}$/)
    await act(async () => end.done({ plan: {} }))
    expect(await first).toEqual({ kind: 'done', result: { plan: {} } })
    expect(result.current.running).toBe(false)
  })

  it('calls a run stopped only where the server says it stopped it', async () => {
    const { result } = hook()
    let run: Promise<unknown> = Promise.resolve()
    act(() => {
      run = result.current.run()
    })
    answer = async () => ({ cancelled: false })
    await act(async () => result.current.stop())
    // Not stopped: it can be stopped again.
    expect(result.current.stopping).toBe(false)
    answer = async () => ({ cancelled: true })
    await act(async () => {
      result.current.stop()
      result.current.stop()
    })
    expect(cancelSql).toHaveBeenCalledTimes(2)
    expect(result.current.stopping).toBe(true)
    await act(async () => end.fail(new Error('stopped')))
    expect(await run).toEqual({ kind: 'stopped' })
    expect(result.current.stopping).toBe(false)
  })

  it('says why a stop did not reach the server, until put away, and a failure of its own as such', async () => {
    const { result } = hook()
    let run: Promise<unknown> = Promise.resolve()
    act(() => {
      run = result.current.run()
    })
    const down = new Error('no connection')
    answer = async () => {
      throw down
    }
    await act(async () => result.current.stop())
    expect(result.current.stopError).toBe(down)
    const timeUp = new Error('its time ran out')
    await act(async () => end.fail(timeUp))
    expect(await run).toEqual({ kind: 'failed', error: timeUp })
    act(() => result.current.clearStopError())
    expect(result.current.stopError).toBeNull()
  })

  it('ends with the run stopped where it is closed while it runs', () => {
    const { result, unmount } = hook()
    act(() => {
      void result.current.run()
    })
    unmount()
    expect(cancelSql).toHaveBeenCalledWith('shop', analyzePlan.mock.calls[0]?.[3])
  })
})
