import { AsyncLocalStorage } from 'node:async_hooks'
import type { MiddlewareHandler } from 'hono'

export interface RequestContext {
  requestId: string
  /** Secrets that must never appear in logs written during this request (e.g. a password being set). */
  redact: string[]
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Makes the request id (and redaction list) available to code that has no access to the Hono context. */
export function requestContext(): MiddlewareHandler {
  return (c, next) => storage.run({ requestId: c.get('requestId') ?? '', redact: [] }, next)
}

export function currentRequest(): RequestContext | undefined {
  return storage.getStore()
}

/** Registers a secret to scrub from audit/log lines for the rest of the current request. */
export function redactInLogs(secret: string): void {
  const ctx = storage.getStore()
  if (ctx && secret.length > 0) ctx.redact.push(secret)
}

/** Runs `fn` with a fresh context (tests / background jobs). */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}
