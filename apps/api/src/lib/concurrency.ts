import type { Context, MiddlewareHandler } from 'hono'

/** One held place in a `ConcurrencyLimit`. Releasing twice is harmless. */
export interface Lease {
  release(): void
}

/**
 * At most `max` of something at once, and no waiting: a place is taken or the caller is refused straight away.
 * Meant for work that costs memory in proportion to its input (an import holds the upload, its unpacked bytes and
 * the decoded text: about 0.6 GB for a maximum-size file), where a queue would only hold the same memory longer.
 */
export class ConcurrencyLimit {
  private inUse = 0

  constructor(readonly max: number) {}

  get active(): number {
    return this.inUse
  }

  tryAcquire(): Lease | null {
    if (this.inUse >= this.max) return null
    this.inUse++
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.inUse--
      },
    }
  }
}

/**
 * Takes a place before the rest of the chain runs (so a refused request never reads its body) and keeps it until the
 * response is over: for a streamed response that is when the stream ends or the client goes away, not when the
 * handler returns, because the work goes on while the body is being read.
 */
export function limitConcurrency(
  limit: ConcurrencyLimit | undefined,
  refused: (c: Context, limit: ConcurrencyLimit) => Response
): MiddlewareHandler {
  return async (c, next) => {
    if (!limit) return next()
    const lease = limit.tryAcquire()
    if (!lease) return refused(c, limit)
    try {
      await next()
    } catch (err) {
      lease.release()
      throw err
    }
    const body = c.res.body
    if (!body) {
      lease.release()
      return
    }
    const reader = body.getReader()
    const held = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            lease.release()
            controller.close()
          } else {
            controller.enqueue(chunk.value)
          }
        } catch (err) {
          lease.release()
          controller.error(err)
        }
      },
      async cancel(reason) {
        lease.release()
        await reader.cancel(reason)
      },
    })
    c.res = new Response(held, c.res)
  }
}
