import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../session/middleware.ts'
import {
  currentRequest,
  type RequestContext,
  redactInLogs,
  requestContext,
  withRequestContext,
} from './request-context.ts'

describe('request context', () => {
  it('has no context outside a request, and registering a secret there is a no-op rather than an error', () => {
    expect(currentRequest()).toBeUndefined()
    expect(() => redactInLogs('hunter2')).not.toThrow()
    expect(currentRequest()).toBeUndefined()
  })

  it('collects the secrets registered during the request, in order, and ignores an empty one', () => {
    const ctx: RequestContext = { requestId: 'r1', redact: [] }
    withRequestContext(ctx, () => {
      redactInLogs('hunter2')
      // An empty string would match everywhere: splitting a line on it would mask every character.
      redactInLogs('')
      redactInLogs("it''s")
      expect(currentRequest()).toBe(ctx)
    })
    expect(ctx.redact).toEqual(['hunter2', "it''s"])
  })

  it('keeps each request to its own secrets, even across awaits', async () => {
    const a: RequestContext = { requestId: 'a', redact: [] }
    const b: RequestContext = { requestId: 'b', redact: [] }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
    await Promise.all([
      withRequestContext(a, async () => {
        await tick()
        redactInLogs('secret-a')
        await tick()
        return currentRequest()?.requestId
      }),
      withRequestContext(b, async () => {
        redactInLogs('secret-b')
        await tick()
        return currentRequest()?.requestId
      }),
    ]).then((ids) => expect(ids).toEqual(['a', 'b']))
    expect(a.redact).toEqual(['secret-a'])
    expect(b.redact).toEqual(['secret-b'])
  })

  it('the middleware gives each request a fresh context carrying its request id (empty when none was set)', async () => {
    const seen: RequestContext[] = []
    const routes = (app: Hono<AppEnv>) =>
      app.use('*', requestContext()).get('/', (c) => {
        redactInLogs('pw')
        const ctx = currentRequest()
        if (ctx) seen.push(ctx)
        return c.text('ok')
      })
    const withId = routes(
      new Hono<AppEnv>().use('*', async (c, next) => {
        c.set('requestId', 'req-42')
        await next()
      })
    )
    const withoutId = routes(new Hono<AppEnv>())
    await withId.request('/')
    await withId.request('/')
    await withoutId.request('/')
    expect(seen).toEqual([
      { requestId: 'req-42', redact: ['pw'] },
      { requestId: 'req-42', redact: ['pw'] },
      { requestId: '', redact: ['pw'] },
    ])
    // Not shared: a secret of one request is not carried into the next one's list.
    expect(seen[0]).not.toBe(seen[1])
    expect(seen[0]?.redact).not.toBe(seen[1]?.redact)
    expect(currentRequest()).toBeUndefined()
  })
})
