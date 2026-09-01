import { AdapterError } from '@tsmyadmin/adapter'
import type { ApiError, ApiErrorCode } from '@tsmyadmin/shared'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Logger } from './logging.ts'

const STATUS_BY_CODE: Record<ApiErrorCode, ContentfulStatusCode> = {
  UNAUTHENTICATED: 401,
  VALIDATION: 400,
  CONNECTION_FAILED: 502,
  AUTH_FAILED: 401,
  NOT_FOUND: 404,
  QUERY_FAILED: 400,
  KEY_MISMATCH: 409,
  UNSUPPORTED: 400,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
}

export function apiError(code: ApiErrorCode, message: string, detail?: string): ApiError {
  return detail === undefined ? { code, message } : { code, message, detail }
}

/** Normalises anything thrown by a route into the error envelope plus the HTTP status it deserves. */
function toApiError(err: unknown): { body: ApiError; status: ContentfulStatusCode } {
  if (err instanceof AdapterError) {
    const body = apiError(err.code, err.message, err.detail)
    return { body, status: STATUS_BY_CODE[body.code] }
  }
  if (err instanceof HTTPException) {
    // Framework 4xx (CSRF 403, body limit 413, …) keep their own status under the VALIDATION envelope.
    const code: ApiErrorCode =
      err.status === 401
        ? 'UNAUTHENTICATED'
        : err.status === 404
          ? 'NOT_FOUND'
          : err.status >= 400 && err.status < 500
            ? 'VALIDATION'
            : 'INTERNAL'
    const status = code === 'INTERNAL' ? STATUS_BY_CODE.INTERNAL : (err.status as ContentfulStatusCode)
    return { body: apiError(code, err.message || `HTTP ${err.status}`), status }
  }
  return {
    body: apiError('INTERNAL', 'Internal error', err instanceof Error ? err.message : String(err)),
    status: STATUS_BY_CODE.INTERNAL,
  }
}

/** Writes the error envelope. Unexpected errors go to the structured log (stack included), never to the client. */
export function errorResponse(c: Context, err: unknown, logger?: Logger): Response {
  const { body, status } = toApiError(err)
  if (body.code === 'INTERNAL') {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    if (logger) logger.log('error', 'unhandled', { requestId: c.get('requestId'), path: c.req.path, error: detail })
    else console.error('[api] unhandled error', err)
  }
  return c.json(body, status)
}
