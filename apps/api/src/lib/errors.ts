import { AdapterError } from '@tsmyadmin/adapter'
import type { ApiError, ApiErrorCode } from '@tsmyadmin/shared'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Logger } from './logging.ts'
import { isStoreUnavailable } from './store-errors.ts'

const STATUS_BY_CODE: Record<ApiErrorCode, ContentfulStatusCode> = {
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
    // Framework 4xx (CSRF 403, body limit 413, …) keep their own status; the code follows the status where one exists.
    const code: ApiErrorCode =
      err.status === 401
        ? 'UNAUTHENTICATED'
        : err.status === 403
          ? 'FORBIDDEN'
          : err.status === 404
            ? 'NOT_FOUND'
            : err.status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : err.status === 429
                ? 'RATE_LIMITED'
                : err.status >= 400 && err.status < 500
                  ? 'VALIDATION'
                  : 'INTERNAL'
    const status = code === 'INTERNAL' ? STATUS_BY_CODE.INTERNAL : (err.status as ContentfulStatusCode)
    const message = err.status === 413 ? 'Request body too large' : err.message || `HTTP ${err.status}`
    return { body: apiError(code, message), status }
  }
  // The store behind the session is down, not this request wrong: say so, so a retry is the obvious thing to do.
  if (isStoreUnavailable(err)) {
    return {
      body: apiError('STORE_UNAVAILABLE', 'The session store is unavailable'),
      status: STATUS_BY_CODE.STORE_UNAVAILABLE,
    }
  }
  // No detail for the client: the message (and stack) go to the structured log in errorResponse only.
  return { body: apiError('INTERNAL', 'Internal error'), status: STATUS_BY_CODE.INTERNAL }
}

/** JSON 404 envelope for unknown API routes (the SPA fallback handles non-API paths). */
export function notFoundResponse(c: Context): Response {
  return c.json(apiError('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`), STATUS_BY_CODE.NOT_FOUND)
}

/**
 * While the session store is down every request fails the same way, so it is logged once a minute (with how many
 * were left out), not once per request: a log shipper should see the outage, not drown in it.
 */
const STORE_LOG_EVERY_MS = 60_000
let storeLoggedAt = Number.NEGATIVE_INFINITY
let storeSuppressed = 0

function logStoreUnavailable(err: unknown, logger: Logger | undefined): void {
  const now = Date.now()
  if (now - storeLoggedAt < STORE_LOG_EVERY_MS) {
    storeSuppressed++
    return
  }
  const fields = { error: err instanceof Error ? err.message : String(err), suppressed: storeSuppressed }
  storeLoggedAt = now
  storeSuppressed = 0
  if (logger) logger.log('error', 'session_store.unavailable', fields)
  else console.error('[api] session store unavailable', fields)
}

/** Writes the error envelope. Unexpected errors go to the structured log (stack included), never to the client. */
export function errorResponse(c: Context, err: unknown, logger?: Logger): Response {
  const { body, status } = toApiError(err)
  if (body.code === 'STORE_UNAVAILABLE') {
    logStoreUnavailable(err, logger)
    return c.json(body, status, { 'Retry-After': '5' })
  }
  if (body.code === 'INTERNAL') {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    if (logger) logger.log('error', 'unhandled', { requestId: c.get('requestId'), path: c.req.path, error: detail })
    else console.error('[api] unhandled error', err)
  }
  return c.json(body, status)
}
