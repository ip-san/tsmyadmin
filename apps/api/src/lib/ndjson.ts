import type { Context } from 'hono'

/** Blank line sent on an NDJSON stream while a statement runs (well inside every idle timeout in the path). */
const HEARTBEAT_MS = 15_000
/** NDJSON responses: progress lines must reach the browser as they are written, not when a proxy buffer fills. */
export const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

export interface NdjsonSource<E> {
  /**
   * The work. `send` writes one event as a line and resolves once the stream has room again, so awaiting it is what
   * keeps a slow reader from making this process buffer everything. A caller that cannot await (a progress
   * callback) may ignore the promise: the events still go out in the order they were sent.
   */
  run(send: (event: E) => Promise<void>): Promise<void>
  /** The last event when `run` throws: the stream cannot change its status any more, so the failure is a line. */
  fatal(err: unknown): E
  /** The reader went away (tab closed, request aborted): stop the work that is still running. */
  onCancel(): Promise<void>
}

/**
 * Answers a request as a stream of newline-delimited JSON: one event per line, a blank line every HEARTBEAT_MS to
 * keep an idle connection open, and the stream closed when `run` ends.
 *
 * `run` starts on the first `pull()`, not in `start()`: the stream calls `pull()` again only after `start()`
 * settles, so awaiting the whole run there would deadlock the wait for room.
 */
export function ndjsonResponse<E>(c: Context, source: NdjsonSource<E>): Response {
  const encoder = new TextEncoder()
  let closed = false
  let started = false
  // Everything waiting for room: a progress callback may send again before the last send has finished.
  let waiting: Array<() => void> = []
  const wake = () => {
    const resume = waiting
    waiting = []
    for (const fn of resume) fn()
  }

  const drive = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const send = async (event: E) => {
      if (closed) return
      while (!closed && controller.desiredSize !== null && controller.desiredSize <= 0) {
        await new Promise<void>((resolve) => waiting.push(resolve))
      }
      if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    }
    const heartbeat = setInterval(() => {
      if (!closed) controller.enqueue(encoder.encode('\n'))
    }, HEARTBEAT_MS)
    try {
      await source.run(send)
    } catch (err) {
      await send(source.fatal(err))
    } finally {
      clearInterval(heartbeat)
      if (!closed) {
        closed = true
        controller.close()
      }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true
        void drive(controller)
        return
      }
      wake()
    },
    async cancel() {
      closed = true
      wake()
      await source.onCancel()
    },
  })
  return c.body(stream, 200, NDJSON_HEADERS)
}
