import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { concurrently, countStatuses, fulfilled, peakInFlight } from '../test/concurrency-harness.ts'
import { ConcurrencyLimit, limitConcurrency } from './concurrency.ts'

const MAX = 3

/**
 * A route behind the limit whose work waits for the test, and whose answer is streamed or not: the place must be
 * held while the work runs and while the body is read, and given back however the request ends.
 */
function app(limit: ConcurrencyLimit, ending: 'json' | 'stream' | 'throw') {
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const work = peakInFlight(async () => {
    await gate
  })
  const hono = new Hono()
    .use(
      '/work',
      limitConcurrency(limit, (c) => c.json({ refused: true }, 429))
    )
    .get('/work', async (c) => {
      await work.run()
      if (ending === 'throw') throw new Error('failed')
      if (ending === 'json') return c.json({ ok: true })
      return c.body(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('a'))
            controller.enqueue(new TextEncoder().encode('b'))
            controller.close()
          },
        })
      )
    })
  hono.onError((_err, c) => c.json({ failed: true }, 500))
  return { hono, open, peak: work.peak }
}

describe('a concurrency limit under a burst', () => {
  for (const ending of ['json', 'stream', 'throw'] as const) {
    it(`never runs more than its places at once, and gives every place back (${ending})`, async () => {
      const limit = new ConcurrencyLimit(MAX)
      const h = app(limit, ending)
      const n = 20
      const pending = concurrently(n, () => h.hono.request('/work'))
      // Let every request reach the limit before any of the admitted ones finishes.
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(limit.active).toBe(MAX)
      h.open()
      const rs = fulfilled(await pending)
      const answered = ending === 'throw' ? 500 : 200
      expect(countStatuses(rs)).toEqual({ [answered]: MAX, 429: n - MAX })
      expect(h.peak()).toBeLessThanOrEqual(MAX)
      // A streamed answer keeps its place until it is read to the end.
      if (ending === 'stream') expect(limit.active).toBe(MAX)
      await Promise.all(rs.map((r) => r.text()))
      expect(limit.active).toBe(0)
    })
  }

  it('hands out no more places than it has, however acquisitions and releases interleave', async () => {
    const limit = new ConcurrencyLimit(MAX)
    let peak = 0
    const results = await concurrently(200, async (i) => {
      await new Promise((resolve) => setTimeout(resolve, i % 7))
      const lease = limit.tryAcquire()
      if (!lease) return false
      peak = Math.max(peak, limit.active)
      await new Promise((resolve) => setTimeout(resolve, i % 5))
      lease.release()
      // Releasing twice gives back one place, not two.
      lease.release()
      return true
    })
    expect(peak).toBeLessThanOrEqual(MAX)
    expect(fulfilled(results).filter(Boolean).length).toBeGreaterThanOrEqual(MAX)
    expect(limit.active).toBe(0)
  })
})
