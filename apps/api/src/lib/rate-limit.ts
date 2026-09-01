/**
 * Fixed-window in-process rate limiter (single-process deployment model).
 * Keys are arbitrary strings (e.g. "ip|user"); expired windows are swept lazily.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Records an attempt and reports whether it is allowed. */
  hit(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now()
    if (this.windows.size > 10_000) this.sweep(t)
    let w = this.windows.get(key)
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + this.windowMs }
      this.windows.set(key, w)
    }
    w.count++
    const allowed = w.count <= this.max
    return { allowed, remaining: Math.max(0, this.max - w.count), retryAfterSec: Math.ceil((w.resetAt - t) / 1000) }
  }

  /** Forgets a key (e.g. after a successful login). */
  reset(key: string): void {
    this.windows.delete(key)
  }

  sweep(t = this.now()): void {
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k)
  }
}
