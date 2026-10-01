import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSweep } from './store.ts'

const timers: ReturnType<typeof setInterval>[] = []
afterEach(() => {
  for (const t of timers.splice(0)) clearInterval(t)
})
const start = (...args: Parameters<typeof startSweep>) => {
  const t = startSweep(...args)
  if (t) timers.push(t)
  return t
}

describe('startSweep', () => {
  it('is off for a zero interval', () => {
    expect(startSweep(0, () => undefined)).toBeNull()
  })

  it('hands a failing run to onError and keeps ticking', async () => {
    let calls = 0
    const onError = vi.fn()
    start(
      5,
      () => {
        calls++
        if (calls <= 2) throw new Error(`failure ${calls}`)
      },
      onError
    )
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(4))
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'failure 1' }))
  })

  it('does not let a rejected promise escape as an unhandled rejection (which ends a Bun process)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const onError = vi.fn()
      start(5, () => Promise.reject(new Error('redis is down')), onError)
      await vi.waitFor(() => expect(onError).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
