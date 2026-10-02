import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ndjsonEvents } from './ndjson.ts'

const Event = z.object({ n: z.number() })

/** A response body that delivers exactly these chunks, the way a network would (split anywhere). */
function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: number[] = []
  for await (const e of ndjsonEvents(stream, Event)) out.push(e.n)
  return out
}

describe('ndjsonEvents', () => {
  it('yields one event per line, across chunk boundaries', async () => {
    expect(await collect(body('{"n":1}\n{"n', '":2}\n{"n":3}\n'))).toEqual([1, 2, 3])
  })

  it('skips the blank lines of the server heartbeat', async () => {
    expect(await collect(body('\n{"n":1}\n\n\n{"n":2}\n'))).toEqual([1, 2])
  })

  it('yields a last event that arrived without its newline', async () => {
    // A proxy or the network may cut the stream right after the last character: that line is still an event, and
    // the one that says the run is over must not be lost as "the connection closed before it finished".
    expect(await collect(body('{"n":1}\n{"n":2}'))).toEqual([1, 2])
  })

  it('does not mistake trailing whitespace for an event', async () => {
    expect(await collect(body('{"n":1}\n  \n'))).toEqual([1])
  })

  it('rejects a line that is not valid JSON, and stops there', async () => {
    await expect(collect(body('{"n":1}\nnot json\n{"n":2}\n'))).rejects.toThrow()
  })

  it('rejects an event that does not match the schema', async () => {
    await expect(collect(body('{"n":"one"}\n'))).rejects.toThrow()
  })
})
