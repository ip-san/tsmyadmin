import type { SecondFactor } from './store.ts'

/**
 * How many wrong proofs an account's second factor takes in a row before it stops answering, and how long that
 * lasts. Counted on the account, not on the address a guess came from: six digits are guessable in a few hundred
 * thousand tries, and a caller with many addresses has a budget per address, not one for the account.
 */
export const MAX_MISSES = 10
/** The lock, and also how long a miss is remembered: a counter nobody has touched for this long starts again. */
export const LOCK_MS = 15 * 60_000

/** The misses that still count at `now`. */
function recent(factor: SecondFactor, now: number): number {
  return factor.lastMissAt !== undefined && now - factor.lastMissAt <= LOCK_MS ? (factor.misses ?? 0) : 0
}

/** How long the account stays locked from `now`; 0 when it answers. */
export function lockLeftMs(factor: SecondFactor, now: number): number {
  const at = factor.lastMissAt
  if (at === undefined || recent(factor, now) < MAX_MISSES) return 0
  return Math.max(0, at + LOCK_MS - now)
}

/** The factor with one more miss, as written before a proof is looked at. */
export function withMiss(factor: SecondFactor, now: number): SecondFactor {
  return { ...factor, misses: recent(factor, now) + 1, lastMissAt: now }
}

/** The factor with the count cleared, as written when a proof is accepted. */
export function withoutMisses(factor: SecondFactor): SecondFactor {
  const { misses: _misses, lastMissAt: _lastMissAt, ...rest } = factor
  return rest
}
