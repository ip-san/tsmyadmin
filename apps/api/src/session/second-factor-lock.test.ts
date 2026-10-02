import { describe, expect, it } from 'vitest'
import { LOCK_MS, lockLeftMs, MAX_MISSES, withMiss, withoutMisses } from './second-factor-lock.ts'
import type { SecondFactor } from './store.ts'

const factor: SecondFactor = { lastStep: -1, recoveryHashes: [], at: 1, version: 'v' }
const T = 1_000_000

/** The factor after `n` misses, one a second. */
function missed(n: number, start = T): SecondFactor {
  let f = factor
  for (let i = 0; i < n; i++) f = withMiss(f, start + i * 1000)
  return f
}

describe('the lock on a second factor', () => {
  it('answers until the limit is reached, then for LOCK_MS after the last miss', () => {
    expect(lockLeftMs(missed(MAX_MISSES - 1), T + 60_000)).toBe(0)
    const locked = missed(MAX_MISSES)
    const last = T + (MAX_MISSES - 1) * 1000
    expect(lockLeftMs(locked, last)).toBe(LOCK_MS)
    expect(lockLeftMs(locked, last + 1000)).toBe(LOCK_MS - 1000)
    expect(lockLeftMs(locked, last + LOCK_MS)).toBe(0)
  })

  it('forgets misses nobody added to for LOCK_MS, so old ones do not add up to a lock', () => {
    const f = missed(MAX_MISSES - 1)
    const later = T + LOCK_MS + 60_000
    expect(withMiss(f, later).misses).toBe(1)
    expect(lockLeftMs(withMiss(f, later), later)).toBe(0)
  })

  it('starts again from one miss when the lock has run out', () => {
    const locked = missed(MAX_MISSES)
    const after = T + MAX_MISSES * 1000 + LOCK_MS + 1
    expect(withMiss(locked, after).misses).toBe(1)
  })

  it('clears the count and keeps everything else, the version included', () => {
    const cleared = withoutMisses(missed(3))
    expect(cleared).toEqual(factor)
    expect('misses' in cleared || 'lastMissAt' in cleared).toBe(false)
  })

  it('leaves the original untouched', () => {
    const before = JSON.stringify(factor)
    withMiss(factor, T)
    withoutMisses(missed(2))
    expect(JSON.stringify(factor)).toBe(before)
  })
})
