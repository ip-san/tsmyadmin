import { AdapterError, type AdapterErrorCode } from '@tsmyadmin/adapter'
import { ApiErrorCodeSchema, ApiErrorSchema } from '@tsmyadmin/shared'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { statusForCode, toApiError } from './errors.ts'

/** Every ApiErrorCode and the HTTP status the envelope must carry. Adding a code without a status fails here. */
const EXPECTED_STATUS = {
  UNAUTHENTICATED: 401,
  VALIDATION: 400,
  CONNECTION_FAILED: 502,
  AUTH_FAILED: 401,
  NOT_FOUND: 404,
  QUERY_FAILED: 400,
  KEY_MISMATCH: 409,
  UNSUPPORTED: 400,
  FORBIDDEN: 403,
  HOST_NOT_ALLOWED: 403,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
} as const

describe('toApiError', () => {
  it('covers every ApiErrorCode', () => {
    expect(Object.keys(EXPECTED_STATUS).sort()).toEqual([...ApiErrorCodeSchema.options].sort())
  })

  it.each(Object.entries(EXPECTED_STATUS))('%s → HTTP %i', (code, status) => {
    expect(statusForCode(ApiErrorCodeSchema.parse(code))).toBe(status)
  })

  const ADAPTER_CODES: AdapterErrorCode[] = [
    'CONNECTION_FAILED',
    'AUTH_FAILED',
    'NOT_FOUND',
    'QUERY_FAILED',
    'KEY_MISMATCH',
    'UNSUPPORTED',
    'PERMISSION_DENIED',
  ]
  it.each(ADAPTER_CODES)('wraps AdapterError %s in a valid envelope with its status', (code) => {
    const out = toApiError(new AdapterError(code, `msg ${code}`, 'detail', { nativeCode: 'X1' }))
    expect(out.status).toBe(EXPECTED_STATUS[code])
    expect(ApiErrorSchema.parse(out.body)).toEqual({ code, message: `msg ${code}`, detail: 'detail', nativeCode: 'X1' })
  })

  it('keeps framework 4xx statuses under the VALIDATION envelope and maps 401/404 to their own codes', () => {
    expect(toApiError(new HTTPException(413, { message: 'too large' }))).toEqual({
      body: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' },
      status: 413,
    })
    expect(toApiError(new HTTPException(401)).body.code).toBe('UNAUTHENTICATED')
    expect(toApiError(new HTTPException(403)).body.code).toBe('FORBIDDEN')
    expect(toApiError(new HTTPException(404)).body.code).toBe('NOT_FOUND')
    expect(toApiError(new HTTPException(429)).body.code).toBe('RATE_LIMITED')
    expect(toApiError(new HTTPException(413)).body).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
    })
    expect(toApiError(new HTTPException(502))).toMatchObject({ body: { code: 'INTERNAL' }, status: 500 })
  })

  it('hides unexpected errors behind INTERNAL without leaking the message to the client', () => {
    expect(toApiError(new TypeError('/srv/app/secret.ts: boom'))).toEqual({
      body: { code: 'INTERNAL', message: 'Internal error' },
      status: 500,
    })
    expect(toApiError('string').body.detail).toBeUndefined()
  })
})
