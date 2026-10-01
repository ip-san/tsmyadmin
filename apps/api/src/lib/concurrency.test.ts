import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ConcurrencyLimit, limitConcurrency } from './concurrency.ts'

describe('ConcurrencyLimit', () => {
  it('refuses beyond max without waiting, and takes a place again once one is released', () => {
    const limit = new ConcurrencyLimit(2)
    const a = limit.tryAcquire()
    const b = limit.tryAcquire()
    expect(a && b).toBeTruthy()
    expect(limit.tryAcquire()).toBeNull()
    expect(limit.active).toBe(2)
    a?.release()
    expect(limit.active).toBe(1)
    expect(limit.tryAcquire()).not.toBeNull()
  })

  it('counts a place once however many times it is released', () => {
    const limit = new ConcurrencyLimit(1)
    const lease = limit.tryAcquire()
    lease?.release()
    lease?.release()
    expect(limit.active).toBe(0)
    expect(limit.tryAcquire()).not.toBeNull()
    expect(limit.tryAcquire()).toBeNull()
  })
})

function app(limit: ConcurrencyLimit, handler: () => Response | Promise<Response>) {
  return new Hono()
    .use(
      '/work',
      limitConcurrency(limit, (c) => c.json({ refused: true }, 429))
    )
    .get('/work', async () => handler())
}

describe('limitConcurrency', () => {
  it('lets the request through when there is a place, and gives it back when a plain response is made', async () => {
    const limit = new ConcurrencyLimit(1)
    const res = await app(limit, () => new Response('done')).request('/work')
    expect(await res.text()).toBe('done')
    expect(limit.active).toBe(0)
  })

  it('refuses with the given response when no place is left', async () => {
    const limit = new ConcurrencyLimit(1)
    limit.tryAcquire()
    const res = await app(limit, () => new Response('never')).request('/work')
    expect(res.status).toBe(429)
    expect(limit.active).toBe(1)
  })

  it('gives the place back when the handler throws', async () => {
    const limit = new ConcurrencyLimit(1)
    const res = await app(limit, () => {
      throw new Error('boom')
    }).request('/work')
    // Hono turns the throw into a 500 response; like any other body it frees the place once it has been read.
    expect(res.status).toBe(500)
    await res.text()
    expect(limit.active).toBe(0)
  })

  it('keeps the place while a streamed body is still being read, and gives it back when it ends', async () => {
    const limit = new ConcurrencyLimit(1)
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('first\n'))
        await gate
        controller.enqueue(new TextEncoder().encode('last\n'))
        controller.close()
      },
    })
    const res = await app(limit, () => new Response(stream)).request('/work')
    // The handler has returned, but the work behind the stream has not: the place is still taken.
    expect(limit.active).toBe(1)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    await reader.read()
    expect(limit.active).toBe(1)
    finish()
    await reader.read()
    await reader.read()
    expect(limit.active).toBe(0)
  })

  it('gives the place back when the client goes away mid-stream', async () => {
    const limit = new ConcurrencyLimit(1)
    const stream = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('x')) })
    const res = await app(limit, () => new Response(stream)).request('/work')
    expect(limit.active).toBe(1)
    await res.body?.cancel()
    expect(limit.active).toBe(0)
  })

  it('is a no-op without a limit', async () => {
    const res = await app(undefined as unknown as ConcurrencyLimit, () => new Response('ok')).request('/work')
    expect(await res.text()).toBe('ok')
  })
})
