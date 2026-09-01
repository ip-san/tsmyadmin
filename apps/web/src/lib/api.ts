import type { AppType } from '@tsmyadmin/api/app'
import { type ApiError as ApiErrorBody, type ApiErrorCode, ApiErrorSchema } from '@tsmyadmin/shared'
import { hc } from 'hono/client'

export const api = hc<AppType>('/', { init: { credentials: 'same-origin' } }).api

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly detail: string | undefined
  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.detail = body.detail
  }
}

/** Unwraps a Hono RPC response: typed JSON on success, ApiError otherwise. */
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
