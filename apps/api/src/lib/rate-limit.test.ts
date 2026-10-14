import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from './rate-limit.ts'

describe('RateLimiter', () => {
  it('allows up to max attempts per window and then blocks with a retry hint', () => {
    let t = 1_000
    const rl = new RateLimiter(3, 10_000, () => t, 0)
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 2 })
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 1 })
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 0 })
    expect(rl.hit('a')).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 10 })
    expect(rl.hit('b').allowed).toBe(true)
    t += 10_000
    expect(rl.hit('a').allowed).toBe(true)
  })

  it('reset forgets a key and sweep drops expired windows', () => {
    let t = 0
    const rl = new RateLimiter(1, 100, () => t, 0)
    rl.hit('a')
    expect(rl.hit('a').allowed).toBe(false)
    rl.reset('a')
    expect(rl.hit('a').allowed).toBe(true)
    t = 200
    rl.sweep()
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 0 })
  })

  it('starts a new window at the very instant the old one ends, not a millisecond earlier', () => {
    let t = 0
    const rl = new RateLimiter(1, 1_000, () => t, 0)
    expect(rl.hit('a')).toMatchObject({ allowed: true, windowEnd: 1_000 })
    t = 999
    expect(rl.hit('a')).toMatchObject({ allowed: false, retryAfterSec: 1, windowEnd: 1_000 })
    expect(rl.peek('a')).toEqual({ allowed: false, retryAfterSec: 1 })
    t = 1_000
    expect(rl.peek('a')).toEqual({ allowed: true, retryAfterSec: 0 })
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 0, retryAfterSec: 1, windowEnd: 2_000 })
  })

  it('rounds the retry hint up to whole seconds and never reports negative remaining', () => {
    let t = 0
    const rl = new RateLimiter(2, 10_000, () => t, 0)
    rl.hit('a')
    rl.hit('a')
    t = 8_500
    expect(rl.hit('a')).toEqual({ allowed: false, remaining: 0, retryAfterSec: 2, windowEnd: 10_000 })
    expect(rl.hit('a')).toMatchObject({ allowed: false, remaining: 0 })
    t = 9_001
    expect(rl.peek('a')).toEqual({ allowed: false, retryAfterSec: 1 })
  })

  it('peek records nothing and blocks exactly once the count reaches max', () => {
    const rl = new RateLimiter(2, 10_000, () => 0, 0)
    expect(rl.peek('a')).toEqual({ allowed: true, retryAfterSec: 0 })
    expect(rl.peek('a')).toEqual({ allowed: true, retryAfterSec: 0 })
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 1 })
    expect(rl.peek('a')).toEqual({ allowed: true, retryAfterSec: 10 })
    rl.hit('a')
    expect(rl.peek('a')).toEqual({ allowed: false, retryAfterSec: 10 })
  })

  it('refund gives one slot back in the window it was counted in, and never below zero', () => {
    const t = 0
    const rl = new RateLimiter(1, 1_000, () => t, 0)
    const first = rl.hit('a')
    expect(rl.peek('a').allowed).toBe(false)
    rl.refund('a', first.windowEnd)
    expect(rl.peek('a').allowed).toBe(true)
    // A second refund of the same slot does not leave credit for an extra attempt.
    rl.refund('a', first.windowEnd)
    rl.refund('a', first.windowEnd)
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 0 })
    expect(rl.hit('a').allowed).toBe(false)
    // Unknown keys are ignored.
    rl.refund('nobody', first.windowEnd)
    expect(rl.peek('nobody')).toEqual({ allowed: true, retryAfterSec: 0 })
  })

  it('refund is ignored once the window it was counted in has ended', () => {
    let t = 0
    const rl = new RateLimiter(1, 1_000, () => t, 0)
    const old = rl.hit('a')
    t = 1_000
    const current = rl.hit('a')
    expect(current.windowEnd).not.toBe(old.windowEnd)
    rl.refund('a', old.windowEnd)
    expect(rl.peek('a').allowed).toBe(false)
    rl.refund('a', current.windowEnd)
    expect(rl.peek('a').allowed).toBe(true)
  })

  it('sweep drops the windows that have ended by the given time and keeps the others', () => {
    const t = 0
    const rl = new RateLimiter(1, 1_000, () => t, 0)
    rl.hit('a')
    // Swept "as of" a time before the end: kept, so the key stays blocked.
    rl.sweep(999)
    expect(rl.hit('a').allowed).toBe(false)
    // As of the end itself: dropped, so the next attempt opens a fresh window.
    rl.sweep(1_000)
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 0 })
  })
})

describe('RateLimiter background sweep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sweeps on a timer (every minute by default) until stopped', () => {
    vi.useFakeTimers()
    let t = 0
    const rl = new RateLimiter(1, 1_000, () => t)
    const sweep = vi.spyOn(rl, 'sweep')
    vi.advanceTimersByTime(59_999)
    expect(sweep).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    rl.stop()
    rl.stop()
    t = 120_000
    vi.advanceTimersByTime(120_000)
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('uses the interval it is given, and none at all for 0', () => {
    vi.useFakeTimers()
    const every = new RateLimiter(1, 1_000, () => 0, 5_000)
    const never = new RateLimiter(1, 1_000, () => 0, 0)
    const a = vi.spyOn(every, 'sweep')
    const b = vi.spyOn(never, 'sweep')
    vi.advanceTimersByTime(10_000)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).not.toHaveBeenCalled()
    every.stop()
  })
})
