import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError } from './api.ts'
import { ndjsonEvents, streamError } from './ndjson.ts'

const Event = z.object({ n: z.number() })

/**
 * A response body that delivers exactly these chunks, the way a network would (split anywhere). With `cancel` the
 * stream is left open, so that closing it early reaches the source.
 */
function body(chunks: string[], cancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      if (!cancel) controller.close()
    },
    ...(cancel ? { cancel } : {}),
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: number[] = []
  for await (const e of ndjsonEvents(stream, Event)) out.push(e.n)
  return out
}
const events = (...chunks: string[]) => collect(body(chunks))

describe('streamError', () => {
  it('reads the JSON error a route answered with, and the bare status when there is none', async () => {
    const e = await streamError(new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'gone' }), { status: 404 }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'gone' })
    const plain = await streamError(new Response('<html>bad gateway</html>', { status: 502 }))
    expect(plain).toMatchObject({ status: 502, code: 'INTERNAL', message: 'HTTP 502' })
    const odd = await streamError(new Response(JSON.stringify({ unexpected: true }), { status: 500 }))
    expect(odd).toMatchObject({ status: 500, code: 'INTERNAL', message: 'HTTP 500' })
    expect(await streamError(new Response(null, { status: 503 }))).toMatchObject({
      code: 'INTERNAL',
      message: 'HTTP 503',
    })
  })
})

describe('ndjsonEvents', () => {
  it('yields one event per line, across chunk boundaries', async () => {
    expect(await events('{"n":1}\n{"n', '":2}\n{"n":3}\n')).toEqual([1, 2, 3])
    expect(await events('{"n"', ':1}\n{"n":', '2}\n')).toEqual([1, 2])
  })

  it('skips the blank lines of the server heartbeat, and trims a line', async () => {
    expect(await events('\n{"n":1}\n\n\n{"n":2}\n')).toEqual([1, 2])
    expect(await events('\n\n{"n":1}\n  \n\r\n  {"n":2}  \r\n\n')).toEqual([1, 2])
    expect(await events()).toEqual([])
    expect(await events('\n\n')).toEqual([])
  })

  it('yields a last event that arrived without its newline', async () => {
    // A proxy or the network may cut the stream right after the last character: that line is still an event, and
    // the one that says the run is over must not be lost as "the connection closed before it finished".
    expect(await events('{"n":1}\n{"n":2}')).toEqual([1, 2])
    expect(await events('{"n":7}')).toEqual([7])
  })

  it('does not mistake trailing whitespace for an event', async () => {
    expect(await events('{"n":1}\n  \n')).toEqual([1])
    expect(await events('{"n":1}\n   ')).toEqual([1])
  })

  it('rejects a line that is not valid JSON, stops there, and closes the body first', async () => {
    const cancel = vi.fn()
    const seen: number[] = []
    await expect(
      (async () => {
        for await (const e of ndjsonEvents(body(['{"n":1}\nnot json\n{"n":3}\n'], cancel), Event)) seen.push(e.n)
      })()
    ).rejects.toThrow(SyntaxError)
    expect(seen).toEqual([1])
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects an event that does not match the schema', async () => {
    await expect(events('{"n":"one"}\n')).rejects.toThrow(z.ZodError)
    await expect(events('{"n":1}\n{"x":1}')).rejects.toThrow(z.ZodError)
  })
})
