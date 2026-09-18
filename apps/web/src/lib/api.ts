import type { AppType } from '@tsmyadmin/api/app'
import { type ApiError as ApiErrorBody, type ApiErrorCode, ApiErrorSchema } from '@tsmyadmin/shared'
import { hc } from 'hono/client'

export const api = hc<AppType>('/', { init: { credentials: 'same-origin' } }).api

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly detail: string | undefined
  readonly nativeCode: string | undefined
  /** Localisable reason of a VALIDATION error, with its parameters (see locale.reasons). */
  readonly reason: string | undefined
  readonly params: Record<string, string | number> | undefined
  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.detail = body.detail
    this.nativeCode = body.nativeCode
    this.reason = body.reason
    this.params = body.params
  }
}

/** Unwraps a Hono RPC response: typed JSON on success, ApiError otherwise. */
/**
 * hc splices path params in verbatim, so names with `/`, `?`, `#` or `%` (legal in both dialects) must be
 * percent-encoded here; Hono decodes `c.req.param()` on the way in.
 */
export const enc = (value: string) => encodeURIComponent(value)

export async function unwrap<T>(
  pending: Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
): Promise<T> {
  let res: Awaited<typeof pending>
  try {
    res = await pending
  } catch (err) {
    throw new ApiError(0, { code: 'INTERNAL', message: err instanceof Error ? err.message : 'network error' })
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(body)
    throw new ApiError(res.status, parsed.success ? parsed.data : { code: 'INTERNAL', message: `HTTP ${res.status}` })
  }
  return body as T
}

export function isApiError(err: unknown, code?: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code)
}

/**
 * Whether a failure means the session is gone and the user has to sign in again. A one-time code that was
 * refused, or asked for, also comes back as 401 — the form that asked for it shows that itself, and throwing the
 * user out to the login page would end a session that is perfectly alive.
 */
export function sessionExpired(err: unknown): boolean {
  if (!isApiError(err) || err.status !== 401) return false
  return err.code !== 'SECOND_FACTOR_INVALID' && err.code !== 'SECOND_FACTOR_REQUIRED'
}
