import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { errorResponse } from './lib/errors.ts'
import { createLogger, type Logger, requestLogger } from './lib/logging.ts'
import { RateLimiter } from './lib/rate-limit.ts'
import { databaseRoutes } from './routes/databases.ts'
import { serverRoutes } from './routes/server.ts'
import { type AdapterFactory, sessionRoutes } from './routes/session.ts'
import { userRoutes } from './routes/users.ts'
import type { AppEnv } from './session/middleware.ts'
import { SESSION_TTL_MS, type SessionStore } from './session/store.ts'

export interface AppDeps {
  adapterFactory: AdapterFactory
  store: SessionStore
  secret: string
  /** Mark the session cookie Secure (production behind HTTPS). */
  secure: boolean
  sessionTtlMs?: number
  allowedHosts?: readonly string[]
  loginRateLimit?: { max: number; windowMs: number }
  trustProxy?: boolean
  logger?: Logger
  /** Injectable clock for the rate limiter (tests). */
  now?: () => number
}

/**
 * Content-Security-Policy for the SPA served by this process. CodeMirror injects <style> elements,
 * so inline styles must be allowed; scripts are only ever loaded from our own origin.
 */
export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
}

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger('pretty', () => undefined)
  const cfg = {
    store: deps.store,
    secret: deps.secret,
    secure: deps.secure,
    ttlMs: deps.sessionTtlMs ?? SESSION_TTL_MS,
  }
  const limit = deps.loginRateLimit ?? { max: 10, windowMs: 60_000 }
  const loginLimiter = new RateLimiter(limit.max, limit.windowMs, deps.now)
  const sessionDeps = {
    adapterFactory: deps.adapterFactory,
    allowedHosts: deps.allowedHosts ?? ['127.0.0.1', 'localhost'],
    loginLimiter,
    trustProxy: deps.trustProxy ?? false,
    logger,
  }
  return (
    new Hono<AppEnv>()
      .use('*', requestId())
      .use('*', requestLogger(logger, sessionDeps.trustProxy))
      .use('*', secureHeaders({ contentSecurityPolicy: CONTENT_SECURITY_POLICY, referrerPolicy: 'same-origin' }))
      .use('/api/*', csrf())
      .onError((err, c) => errorResponse(c, err))
      // Liveness: the process answers. Readiness: the session store is usable.
      .get('/healthz', (c) => c.json({ ok: true }))
      .get('/readyz', async (c) => {
        try {
          await deps.store.ping()
          return c.json({ ok: true })
        } catch (err) {
          logger.log('error', 'readyz.failed', { error: err instanceof Error ? err.message : String(err) })
          return c.json({ ok: false }, 503)
        }
      })
      .get('/api/health', (c) => c.json({ ok: true }))
      .route('/api', sessionRoutes(cfg, sessionDeps))
      .route('/api', databaseRoutes(cfg))
      .route('/api', userRoutes(cfg))
      .route('/api', serverRoutes(cfg))
  )
}

export type AppType = ReturnType<typeof createApp>
