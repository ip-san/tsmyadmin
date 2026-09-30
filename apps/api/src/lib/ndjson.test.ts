import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { NDJSON_HEADERS, ndjsonResponse } from './ndjson.ts'

type Ev = { n: number } | { fatal: string }

function serve(source: Parameters<typeof ndjsonResponse<Ev>>[1]) {
  return new Hono().get('/x', (c) => ndjsonResponse<Ev>(c, source)).request('/x')
}

const lines = (text: string) => text.split('\n').filter((l) => l !== '')

describe('ndjsonResponse', () => {
  it('writes one event per line, in order, and ends when run ends', async () => {
    const res = await serve({
      run: async (send) => {
        await send({ n: 1 })
        await send({ n: 2 })
      },
      fatal: () => ({ fatal: 'unused' }),
      onCancel: async () => undefined,
    })
    expect(res.headers.get('content-type')).toBe(NDJSON_HEADERS['content-type'])
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(lines(await res.text()).map((l) => JSON.parse(l))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('turns an error thrown by run into a last fatal event', async () => {
    const res = await serve({
      run: async (send) => {
        await send({ n: 1 })
        throw new Error('boom')
      },
      fatal: (err) => ({ fatal: (err as Error).message }),
      onCancel: async () => undefined,
    })
    expect(lines(await res.text()).map((l) => JSON.parse(l))).toEqual([{ n: 1 }, { fatal: 'boom' }])
  })

  it('keeps events in order when a caller sends without awaiting (a progress callback)', async () => {
    const res = await serve({
      run: async (send) => {
        for (let n = 1; n <= 20; n++) void send({ n })
        await send({ n: 21 })
      },
      fatal: () => ({ fatal: 'unused' }),
      onCancel: async () => undefined,
    })
    const seen = lines(await res.text()).map((l) => (JSON.parse(l) as { n: number }).n)
    expect(seen).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
  })

  it('makes run wait while the reader has not read (backpressure), then continues as it reads', async () => {
    let sent = 0
    let finished = false
    const res = await serve({
      run: async (send) => {
        for (let n = 1; n <= 5; n++) {
          await send({ n })
          sent = n
        }
        finished = true
      },
      fatal: () => ({ fatal: 'unused' }),
      onCancel: async () => undefined,
    })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    await new Promise((r) => setTimeout(r, 20))
    // Nothing has been read: the stream holds its own small queue and run is parked, not finished.
    expect(finished).toBe(false)
    expect(sent).toBeLessThan(5)
    const seen: number[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const l of lines(new TextDecoder().decode(value))) seen.push((JSON.parse(l) as { n: number }).n)
    }
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(finished).toBe(true)
  })

  it('calls onCancel and drops further events when the reader goes away', async () => {
    const onCancel = vi.fn(async () => undefined)
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let afterCancel: unknown = 'not reached'
    const res = await serve({
      run: async (send) => {
        await send({ n: 1 })
        await gate
        await send({ n: 2 })
        afterCancel = 'sent after cancel'
      },
      fatal: () => ({ fatal: 'unused' }),
      onCancel,
    })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    await reader.read()
    await reader.cancel()
    expect(onCancel).toHaveBeenCalledOnce()
    release()
    await new Promise((r) => setTimeout(r, 10))
    // run was not stopped by the stream itself (onCancel does that); the event it sends after is simply dropped.
    expect(afterCancel).toBe('sent after cancel')
  })
})
