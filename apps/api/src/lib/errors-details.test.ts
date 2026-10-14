import { AdapterError } from '@tsmyadmin/adapter'
import type { ApiErrorCode } from '@tsmyadmin/shared'
import { type Context, type Handler, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConcurrencyLimit, limitConcurrency } from './concurrency.ts'
import { apiError, errorResponse, notFoundResponse, statusForCode, toApiError } from './errors.ts'
import type { Logger } from './logging.ts'

/**
 * What a client is told about a failure, how a failure is logged, and how a limited place is held and given back
 * (found as surviving mutants; see `bun run mutation`).
 */

const storeDown = () => Object.assign(new Error('x'), { name: 'MaxRetriesPerRequestError' })

describe('the status of each error code', () => {
  it('maps every code to the HTTP status it deserves', () => {
    const table: Record<ApiErrorCode, number> = {
      UNAUTHENTICATED: 401,
      VALIDATION: 400,
      CONNECTION_FAILED: 502,
      AUTH_FAILED: 401,
      NOT_FOUND: 404,
      QUERY_FAILED: 400,
      KEY_MISMATCH: 409,
      CONFLICT: 409,
      UNSUPPORTED: 400,
      FORBIDDEN: 403,
      HOST_NOT_ALLOWED: 403,
      INSECURE_TRANSPORT: 400,
      PAYLOAD_TOO_LARGE: 413,
      PERMISSION_DENIED: 403,
      RATE_LIMITED: 429,
      SECOND_FACTOR_REQUIRED: 401,
      SECOND_FACTOR_INVALID: 401,
      STORE_UNAVAILABLE: 503,
      INTERNAL: 500,
    }
    for (const [code, status] of Object.entries(table)) expect(statusForCode(code as ApiErrorCode), code).toBe(status)
  })

  it('writes the optional parts of an envelope only when they are given, an empty one included', () => {
    expect(apiError('NOT_FOUND', 'm')).toEqual({ code: 'NOT_FOUND', message: 'm' })
    expect(apiError('NOT_FOUND', 'm', 'd')).toEqual({ code: 'NOT_FOUND', message: 'm', detail: 'd' })
    expect(apiError('NOT_FOUND', 'm', undefined, 'n')).toEqual({ code: 'NOT_FOUND', message: 'm', nativeCode: 'n' })
    expect(apiError('NOT_FOUND', 'm', '', '')).toEqual({ code: 'NOT_FOUND', message: 'm', detail: '', nativeCode: '' })
    expect(Object.keys(apiError('NOT_FOUND', 'm'))).toEqual(['code', 'message'])
  })
})

describe('toApiError', () => {
  it('keeps the code, message and detail of an adapter error, with the status of its code', () => {
    const e = new AdapterError('KEY_MISMATCH', 'row changed', 'the detail', { nativeCode: 'N1' })
    expect(toApiError(e)).toEqual({
      body: { code: 'KEY_MISMATCH', message: 'row changed', detail: 'the detail', nativeCode: 'N1' },
      status: 409,
    })
    expect(toApiError(new AdapterError('NOT_FOUND', 'gone'))).toEqual({
      body: { code: 'NOT_FOUND', message: 'gone' },
      status: 404,
    })
  })

  it('gives a framework error its own status, and the code that follows it', () => {
    const cases: [number, ApiErrorCode, number][] = [
      [401, 'UNAUTHENTICATED', 401],
      [403, 'FORBIDDEN', 403],
      [404, 'NOT_FOUND', 404],
      [413, 'PAYLOAD_TOO_LARGE', 413],
      [429, 'RATE_LIMITED', 429],
      [400, 'VALIDATION', 400],
      [405, 'VALIDATION', 405],
      [418, 'VALIDATION', 418],
      [499, 'VALIDATION', 499],
      [500, 'INTERNAL', 500],
      [502, 'INTERNAL', 500],
      [503, 'INTERNAL', 500],
    ]
    for (const [httpStatus, code, status] of cases) {
      const out = toApiError(new HTTPException(httpStatus as 400))
      expect(out.body.code, String(httpStatus)).toBe(code)
      expect(out.status, String(httpStatus)).toBe(status)
    }
  })

  it('says the body was too large in its own words, and otherwise the message it was given or the status', () => {
    expect(toApiError(new HTTPException(413, { message: 'whatever the framework said' })).body.message).toBe(
      'Request body too large'
    )
    expect(toApiError(new HTTPException(403, { message: 'CSRF blocked' })).body.message).toBe('CSRF blocked')
    expect(toApiError(new HTTPException(404)).body.message).toBe('HTTP 404')
    expect(toApiError(new HTTPException(400, { message: '' })).body.message).toBe('HTTP 400')
    expect(toApiError(new HTTPException(502)).body.message).toBe('HTTP 502')
  })

  it('answers 503 for a session store that is down, and 500 with nothing from the error for anything else', () => {
    expect(toApiError(storeDown())).toEqual({
      body: { code: 'STORE_UNAVAILABLE', message: 'The session store is unavailable' },
      status: 503,
    })
    expect(toApiError(new Error('secret detail'))).toEqual({
      body: { code: 'INTERNAL', message: 'Internal error' },
      status: 500,
    })
    expect(toApiError('a string')).toEqual({ body: { code: 'INTERNAL', message: 'Internal error' }, status: 500 })
    expect(toApiError(null).body.code).toBe('INTERNAL')
  })
})

describe('responses', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const respond = async (err: unknown, logger?: Logger, path = '/x', write = errorResponse) => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('requestId' as never, 'rid-7' as never)
      await next()
    })
    app.all('*', (c) => write(c, err, logger))
    const res = await app.request(path, { method: 'POST' })
    return { res, body: (await res.json()) as Record<string, unknown> }
  }
  const spyLogger = () => {
    const calls: { level: string; event: string; fields: Record<string, unknown> | undefined }[] = []
    const logger: Logger = { log: (level, event, fields) => calls.push({ level, event, fields }) }
    return { calls, logger }
  }

  it('answers an unknown route with a JSON 404 naming the method and path', async () => {
    const app = new Hono()
    app.all('*', (c) => notFoundResponse(c))
    const res = await app.request('/api/nope?x=1', { method: 'PUT' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'No route for PUT /api/nope' })
  })

  it('logs an unexpected error with its stack, the request id and path, and tells the client nothing of it', async () => {
    const { calls, logger } = spyLogger()
    const err = new Error('secret detail')
    const { res, body } = await respond(err, logger, '/api/x')
    expect(res.status).toBe(500)
    expect(body).toEqual({ code: 'INTERNAL', message: 'Internal error' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ level: 'error', event: 'unhandled' })
    expect(calls[0]?.fields).toMatchObject({ requestId: 'rid-7', path: '/api/x' })
    expect(String(calls[0]?.fields?.error)).toContain('secret detail')
    expect(String(calls[0]?.fields?.error)).toContain('Error: secret detail\n    at')
  })

  it('logs the message when there is no stack, and the text of a thrown value that is no error', async () => {
    const noStack = Object.assign(new Error('only a message'), { stack: undefined })
    const a = spyLogger()
    await respond(noStack, a.logger)
    expect(a.calls[0]?.fields?.error).toBe('only a message')
    const b = spyLogger()
    await respond('plain text', b.logger)
    expect(b.calls[0]?.fields?.error).toBe('plain text')
  })

  it('writes to the console when there is no logger, and logs nothing for an error the client caused', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const err = new Error('boom')
    await respond(err)
    expect(spy).toHaveBeenCalledWith('[api] unhandled error', err)
    spy.mockClear()
    const { calls, logger } = spyLogger()
    const { res } = await respond(new AdapterError('NOT_FOUND', 'gone'), logger)
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
    await respond(new HTTPException(404))
    expect(spy).not.toHaveBeenCalled()
  })

  describe('a store that is down', () => {
    /**
     * When the outage was last logged is kept in the module, so each test here starts from a fresh copy of it rather
     * than from where the previous test left the clock.
     */
    const fresh = async () => {
      vi.resetModules()
      const { errorResponse: write } = await import('./errors.ts')
      return (err: unknown, logger?: Logger) => respond(err, logger, '/x', write)
    }

    it('answers 503 with Retry-After, and logs the outage once a minute with how many were left out', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
      const respondFresh = await fresh()
      const { calls, logger } = spyLogger()
      const first = await respondFresh(storeDown(), logger)
      expect(first.res.status).toBe(503)
      expect(first.res.headers.get('Retry-After')).toBe('5')
      expect(first.body).toEqual({ code: 'STORE_UNAVAILABLE', message: 'The session store is unavailable' })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ level: 'error', event: 'session_store.unavailable' })
      expect(calls[0]?.fields).toEqual({ error: 'x', suppressed: 0 })
      vi.setSystemTime(new Date('2030-01-01T00:00:30Z'))
      await respondFresh(storeDown(), logger)
      await respondFresh(storeDown(), logger)
      expect(calls).toHaveLength(1)
      vi.setSystemTime(new Date('2030-01-01T00:00:59.999Z'))
      await respondFresh(storeDown(), logger)
      expect(calls).toHaveLength(1)
      // A minute after the last line, exactly, the next one is written, saying how many were left out.
      vi.setSystemTime(new Date('2030-01-01T00:01:00Z'))
      await respondFresh(storeDown(), logger)
      expect(calls).toHaveLength(2)
      expect(calls[1]?.fields).toEqual({ error: 'x', suppressed: 3 })
    })

    it('writes the outage to the console when there is no logger', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
      const respondFresh = await fresh()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await respondFresh(storeDown())
      expect(spy).toHaveBeenCalledWith('[api] session store unavailable', { error: 'x', suppressed: 0 })
      const text = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.setSystemTime(new Date('2030-01-01T00:05:00Z'))
      await respondFresh(new Error('Connection is closed.'))
      expect(text).toHaveBeenCalledWith('[api] session store unavailable', {
        error: 'Connection is closed.',
        suppressed: 0,
      })
    })
  })
})

describe('ConcurrencyLimit', () => {
  it('hands out places up to its maximum and refuses the next without waiting, a released place being free again', () => {
    const limit = new ConcurrencyLimit(2)
    expect(limit.max).toBe(2)
    expect(limit.active).toBe(0)
    const a = limit.tryAcquire()
    const b = limit.tryAcquire()
    expect(limit.active).toBe(2)
    expect(limit.tryAcquire()).toBeNull()
    expect(limit.active).toBe(2)
    a?.release()
    expect(limit.active).toBe(1)
    expect(limit.tryAcquire()).not.toBeNull()
    expect(limit.active).toBe(2)
    b?.release()
    expect(limit.active).toBe(1)
  })

  it('counts a place released twice once', () => {
    const limit = new ConcurrencyLimit(1)
    const lease = limit.tryAcquire()
    lease?.release()
    lease?.release()
    expect(limit.active).toBe(0)
    const again = limit.tryAcquire()
    lease?.release()
    expect(limit.active).toBe(1)
    again?.release()
    expect(limit.active).toBe(0)
    expect(new ConcurrencyLimit(0).tryAcquire()).toBeNull()
  })
})

describe('limitConcurrency', () => {
  const refusal = (c: { text: (t: string, s: 429) => Response }) => c.text('busy', 429)
  const build = (limit: ConcurrencyLimit | undefined, handler: Handler) => {
    const app = new Hono()
    app.use('*', limitConcurrency(limit, refusal as never))
    app.get('/x', handler)
    return app
  }

  it('does nothing without a limit', async () => {
    const res = await build(undefined, (c) => c.text('ok')).request('/x')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('refuses at once when the limit is reached, without running the handler', async () => {
    const limit = new ConcurrencyLimit(1)
    limit.tryAcquire()
    const handler = vi.fn((c: Context) => c.text('ok'))
    const res = await build(limit, handler).request('/x')
    expect(res.status).toBe(429)
    expect(await res.text()).toBe('busy')
    expect(handler).not.toHaveBeenCalled()
    expect(limit.active).toBe(1)
  })

  it('gives the place back as the handler returns when the response has no body', async () => {
    const limit = new ConcurrencyLimit(1)
    const res = await build(limit, (c) => c.body(null, 204)).request('/x')
    expect(res.status).toBe(204)
    expect(limit.active).toBe(0)
  })

  it('gives the place back when the handler throws, and throws on', async () => {
    const limit = new ConcurrencyLimit(1)
    const app = build(limit, () => {
      throw new Error('handler failed')
    })
    app.onError((err, c) => c.text(err.message, 500))
    const res = await app.request('/x')
    expect(await res.text()).toBe('handler failed')
    expect(limit.active).toBe(0)
  })

  it('keeps the place while the body is being read, and gives it back when the stream ends', async () => {
    const limit = new ConcurrencyLimit(1)
    let push: (chunk: string) => void = () => undefined
    let end: () => void = () => undefined
    const res = await build(limit, (c) =>
      c.body(
        new ReadableStream({
          start(controller) {
            push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk))
            end = () => controller.close()
          },
        })
      )
    ).request('/x')
    expect(limit.active).toBe(1)
    const reader = res.body?.getReader()
    push('a')
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('a')
    expect(limit.active).toBe(1)
    end()
    expect((await reader?.read())?.done).toBe(true)
    expect(limit.active).toBe(0)
  })

  it('gives the place back when the client goes away mid-stream, and when the stream fails', async () => {
    const cancelled = new ConcurrencyLimit(1)
    const cancel = vi.fn()
    const res = await build(cancelled, (c) =>
      c.body(new ReadableStream({ pull: () => new Promise(() => undefined), cancel }))
    ).request('/x')
    expect(cancelled.active).toBe(1)
    await res.body?.cancel('client left')
    expect(cancelled.active).toBe(0)
    expect(cancel).toHaveBeenCalledWith('client left')

    const failed = new ConcurrencyLimit(1)
    const failing = await build(failed, (c) =>
      c.body(new ReadableStream({ pull: () => Promise.reject(new Error('stream broke')) }))
    ).request('/x')
    await expect(failing.text()).rejects.toThrow('stream broke')
    expect(failed.active).toBe(0)
  })
})
