import { describe, expect, it, vi } from 'vitest'
import { poolBusyError, withinAcquireTimeout } from './driver.ts'

const conn = () => ({ release: vi.fn() })
const never = <T>() => new Promise<T>(() => undefined)

describe('withinAcquireTimeout', () => {
  it('hands over a connection that arrives in time, and leaves it with the caller', async () => {
    const c = conn()
    expect(await withinAcquireTimeout(Promise.resolve(c), 50)).toBe(c)
    expect(c.release).not.toHaveBeenCalled()
  })

  it('answers with the pool-busy error when no connection becomes free in time', async () => {
    const started = performance.now()
    const err = await withinAcquireTimeout(never<ReturnType<typeof conn>>(), 30).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'CONNECTION_FAILED', message: 'No connection became free in time' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
    expect(poolBusyError().detail).toContain('busy')
  })

  it('gives a connection that is served after the caller gave up straight back to the pool', async () => {
    const c = conn()
    let serve: (c: ReturnType<typeof conn>) => void = () => undefined
    const attempt = new Promise<ReturnType<typeof conn>>((resolve) => {
      serve = resolve
    })
    await expect(withinAcquireTimeout(attempt, 20)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' })
    serve(c)
    await vi.waitFor(() => expect(c.release).toHaveBeenCalledTimes(1))
  })

  it('passes on the failure of the attempt itself, and does not report it as a timeout', async () => {
    const boom = new Error('connect ECONNREFUSED')
    await expect(withinAcquireTimeout(Promise.reject(boom), 50)).rejects.toBe(boom)
  })

  it('does not leave a timer behind once the connection has arrived', async () => {
    vi.useFakeTimers()
    try {
      const c = conn()
      await withinAcquireTimeout(Promise.resolve(c), 10_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
