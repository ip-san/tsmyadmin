import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NDJSON_HEADERS, type NdjsonSource, ndjsonResponse } from './ndjson.ts'

/** The stream a long statement answers with: its lines, its failure line, its heartbeat and what a closed tab stops. */

const ctx = {
  body: (stream: ReadableStream, status: number, headers: Record<string, string>) =>
    new Response(stream, { status, headers }),
} as unknown as Context
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)

async function readAll(res: Response): Promise<string> {
  return await res.text()
}

function source(run: NdjsonSource<unknown>['run'], extra: Partial<NdjsonSource<unknown>> = {}): NdjsonSource<unknown> {
  return {
    run,
    fatal: (err) => ({ kind: 'fatal', message: (err as Error).message }),
    onCancel: async () => undefined,
    ...extra,
  }
}

describe('ndjsonResponse', () => {
  afterEach(() => vi.useRealTimers())

  it('answers 200 with the headers that keep a proxy from holding the lines back', async () => {
    const res = ndjsonResponse(
      ctx,
      source(async () => undefined)
    )
    expect(res.status).toBe(200)
    expect(NDJSON_HEADERS).toEqual({
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    for (const [k, v] of Object.entries(NDJSON_HEADERS)) expect(res.headers.get(k), k).toBe(v)
    await res.text()
  })

  it('writes each event as a line of JSON, in the order sent, and ends the stream when the work ends', async () => {
    const res = ndjsonResponse(
      ctx,
      source(async (send) => {
        await send({ kind: 'a', n: 1 })
        await send({ kind: 'b', text: 'line\nbreak "quoted"' })
        await send(null)
      })
    )
    expect(await readAll(res)).toBe('{"kind":"a","n":1}\n{"kind":"b","text":"line\\nbreak \\"quoted\\""}\nnull\n')
    expect(
      await readAll(
        ndjsonResponse(
          ctx,
          source(async () => undefined)
        )
      )
    ).toBe('')
  })

  it('keeps every line when the reader is slower than the work, in order', async () => {
    const res = ndjsonResponse(
      ctx,
      source(async (send) => {
        for (let i = 0; i < 20; i++) await send({ i })
      })
    )
    const reader = res.body?.getReader()
    const lines: string[] = []
    for (;;) {
      await new Promise((r) => setTimeout(r, 1))
      const { done, value } = (await reader?.read()) ?? { done: true, value: undefined }
      if (done) break
      lines.push(decode(value))
    }
    expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `{"i":${i}}\n`))
  })

  it('ends with the failure as a last line when the work throws, and still closes', async () => {
    const res = ndjsonResponse(
      ctx,
      source(async (send) => {
        await send({ kind: 'progress' })
        throw new Error('boom')
      })
    )
    expect(await readAll(res)).toBe('{"kind":"progress"}\n{"kind":"fatal","message":"boom"}\n')
  })

  it('sends a blank line every 15 seconds while the work runs, none before, and none once it has ended', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const res = ndjsonResponse(
      ctx,
      source(async (send) => {
        await send({ kind: 'start' })
        await new Promise<void>((resolve) => {
          release = resolve
        })
        await send({ kind: 'end' })
      })
    )
    const reader = res.body?.getReader()
    expect(decode((await reader?.read())?.value)).toBe('{"kind":"start"}\n')
    let settled = false
    const next = reader?.read().then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(decode((await next)?.value)).toBe('\n')
    expect(vi.getTimerCount()).toBe(1)
    release()
    expect(decode((await reader?.read())?.value)).toBe('{"kind":"end"}\n')
    expect((await reader?.read())?.done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the work and sends nothing more when the reader goes away', async () => {
    const onCancel = vi.fn(async () => undefined)
    const sent: boolean[] = []
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const res = ndjsonResponse(
      ctx,
      source(
        async (send) => {
          await send({ n: 1 })
          await gate
          await send({ n: 2 })
          sent.push(true)
        },
        { onCancel }
      )
    )
    const reader = res.body?.getReader()
    expect(decode((await reader?.read())?.value)).toBe('{"n":1}\n')
    await reader?.cancel()
    expect(onCancel).toHaveBeenCalledTimes(1)
    finish()
    await new Promise((r) => setTimeout(r, 5))
    // The work ran to its end, its late event went nowhere, and nothing failed.
    expect(sent).toEqual([true])
  })

  it('lets a progress callback send without waiting, the events still going out in order', async () => {
    const res = ndjsonResponse(
      ctx,
      source(async (send) => {
        for (let i = 0; i < 5; i++) void send({ i })
        await send({ last: true })
      })
    )
    const text = await readAll(res)
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    ).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { last: true }])
  })
})
