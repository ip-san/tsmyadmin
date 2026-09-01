import { AdapterError } from '@tsmyadmin/adapter'
import type { ApiError, ApiErrorCode } from '@tsmyadmin/shared'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

const STATUS_BY_CODE: Record<ApiErrorCode, ContentfulStatusCode> = {
  UNAUTHENTICATED: 401,
  VALIDATION: 400,
  CONNECTION_FAILED: 502,
  AUTH_FAILED: 401,
  NOT_FOUND: 404,
  QUERY_FAILED: 400,
  KEY_MISMATCH: 409,
  UNSUPPORTED: 400,
  INTERNAL: 500,
}

export function apiError(code: ApiErrorCode, message: string, detail?: string): ApiError {
  return detail === undefined ? { code, message } : { code, message, detail }
}

/** Normalises anything thrown by a route into { code, message, detail }. */
function toApiError(err: unknown): ApiError {
  if (err instanceof AdapterError) return apiError(err.code, err.message, err.detail)
  if (err instanceof HTTPException) {
    const code: ApiErrorCode =
      err.status === 401
        ? 'UNAUTHENTICATED'
        : err.status === 404
          ? 'NOT_FOUND'
          : err.status >= 400 && err.status < 500
            ? 'VALIDATION'
            : 'INTERNAL'
    return apiError(code, err.message || `HTTP ${err.status}`)
  }
  return apiError('INTERNAL', 'Internal error', err instanceof Error ? err.message : String(err))
}

export function errorResponse(c: Context, err: unknown): Response {
  const body = toApiError(err)
  if (body.code === 'INTERNAL') console.error('[api] unhandled error', err)
  // Framework 4xx (CSRF 403, body limit 413, …) keep their own status under the VALIDATION envelope.
  const status = err instanceof HTTPException && body.code === 'VALIDATION' ? err.status : STATUS_BY_CODE[body.code]
  return c.json(body, status)
}
