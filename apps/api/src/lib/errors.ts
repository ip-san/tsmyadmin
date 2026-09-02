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
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
}

/** HTTP status carried by each error code. */
export function statusForCode(code: ApiErrorCode): ContentfulStatusCode {
  return STATUS_BY_CODE[code]
}

export function apiError(code: ApiErrorCode, message: string, detail?: string, nativeCode?: string): ApiError {
  return {
    code,
    message,
    ...(detail === undefined ? {} : { detail }),
    ...(nativeCode === undefined ? {} : { nativeCode }),
  }
}

/** Normalises anything thrown by a route into the error envelope plus the HTTP status it deserves. */
export function toApiError(err: unknown): { body: ApiError; status: ContentfulStatusCode } {
  if (err instanceof AdapterError) {
    const body = apiError(err.code, err.message, err.detail, err.nativeCode)
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

/** JSON 404 envelope for unknown API routes (the SPA fallback handles non-API paths). */
export function notFoundResponse(c: Context): Response {
  return c.json(apiError('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`), STATUS_BY_CODE.NOT_FOUND)
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
