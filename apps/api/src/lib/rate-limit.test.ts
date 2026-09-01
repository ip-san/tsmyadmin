import { describe, expect, it } from 'vitest'
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
})
