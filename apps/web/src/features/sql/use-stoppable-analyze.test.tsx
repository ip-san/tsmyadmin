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
    expect(await first).toEqual({ kind: 'done', result: { plan: {} }, times: [] })
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

  describe('a series of runs', () => {
    const ran = (ms: number) => ({ plan: { ms }, measured: { ms } })

    it('runs one after another, each under an id of its own, and keeps every time and the last plan', async () => {
      const { result } = hook()
      let series: Promise<unknown> = Promise.resolve()
      act(() => {
        series = result.current.run(3)
      })
      expect(result.current.progress).toEqual({ at: 1, of: 3 })
      await act(async () => end.done(ran(40)))
      expect(result.current.progress).toEqual({ at: 2, of: 3 })
      // A press while it goes on is caught between the runs too.
      let again: Promise<unknown> = Promise.resolve()
      act(() => {
        again = result.current.run()
      })
      expect(await again).toBeNull()
      await act(async () => end.done(ran(5)))
      await act(async () => end.done(ran(6)))
      expect(await series).toEqual({ kind: 'done', result: ran(6), times: [40, 5, 6] })
      const ids = analyzePlan.mock.calls.map((c) => c[3])
      expect(new Set(ids).size).toBe(3)
      expect(result.current.progress).toBeNull()
      expect(result.current.running).toBe(false)
    })

    it('ends the series on a stop, keeping the runs that ended', async () => {
      const { result } = hook()
      let series: Promise<unknown> = Promise.resolve()
      act(() => {
        series = result.current.run(3)
      })
      await act(async () => end.done(ran(40)))
      await act(async () => result.current.stop())
      // The stop reaches the run going, not the one that ended.
      expect(cancelSql).toHaveBeenCalledWith('shop', analyzePlan.mock.calls[1]?.[3])
      await act(async () => end.fail(new Error('stopped')))
      expect(await series).toEqual({ kind: 'stopped', partial: { result: ran(40), times: [40] } })
      expect(analyzePlan).toHaveBeenCalledTimes(2)
    })

    it('starts no further run where the stop came as a run ended (the server stopped nothing)', async () => {
      const { result } = hook()
      let series: Promise<unknown> = Promise.resolve()
      act(() => {
        series = result.current.run(3)
      })
      answer = async () => ({ cancelled: false })
      await act(async () => result.current.stop())
      await act(async () => end.done(ran(40)))
      expect(await series).toEqual({ kind: 'stopped', partial: { result: ran(40), times: [40] } })
      expect(analyzePlan).toHaveBeenCalledTimes(1)
    })

    it('keeps the runs that ended where a later one fails', async () => {
      const { result } = hook()
      let series: Promise<unknown> = Promise.resolve()
      act(() => {
        series = result.current.run(3)
      })
      await act(async () => end.done(ran(40)))
      const timeUp = new Error('its time ran out')
      await act(async () => end.fail(timeUp))
      expect(await series).toEqual({ kind: 'failed', error: timeUp, partial: { result: ran(40), times: [40] } })
    })

    it('goes on where the stop did not reach the server', async () => {
      const { result } = hook()
      let series: Promise<unknown> = Promise.resolve()
      act(() => {
        series = result.current.run(2)
      })
      answer = async () => {
        throw new Error('no connection')
      }
      await act(async () => result.current.stop())
      await act(async () => end.done(ran(40)))
      await act(async () => end.done(ran(5)))
      expect(await series).toEqual({ kind: 'done', result: ran(5), times: [40, 5] })
    })

    it('starts no further run once closed', async () => {
      const { result, unmount } = hook()
      let series: Promise<unknown> = Promise.resolve()
      act(() => {
        series = result.current.run(3)
      })
      unmount()
      end.done(ran(40))
      expect(await series).toEqual({ kind: 'stopped', partial: { result: ran(40), times: [40] } })
      expect(analyzePlan).toHaveBeenCalledTimes(1)
    })
  })
})
