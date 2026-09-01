import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import type { AppConfig } from './config.ts'
import { errorResponse } from './lib/errors.ts'
import { clientIp, createLogger, type Logger, type RemoteAddress, requestLogger } from './lib/logging.ts'
import { RateLimiter } from './lib/rate-limit.ts'
import { requestContext } from './lib/request-context.ts'
import { databaseRoutes } from './routes/databases.ts'
import { serverRoutes } from './routes/server.ts'
import { sessionRoutes } from './routes/session.ts'
import { userRoutes } from './routes/users.ts'
import type { AppEnv } from './session/middleware.ts'
import type { SessionStore } from './session/store.ts'

/** Runtime services injected next to the validated configuration (all defaults live in loadConfig). */
export interface AppServices {
  /** Session store; it owns the (audited) adapter factory. */
  store: SessionStore
  logger?: Logger
  /** Socket remote address resolver (Bun: getConnInfo). Without it every direct client counts as "unknown". */
  remoteAddress?: RemoteAddress
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

export function createApp(config: AppConfig, services: AppServices) {
  const logger = services.logger ?? createLogger('pretty', () => undefined)
  const cfg = { store: services.store, secret: config.sessionSecret, secure: config.isProd, ttlMs: config.sessionTtlMs }
  const loginLimiter = new RateLimiter(config.loginRateLimit.max, config.loginRateLimit.windowMs, services.now)
  const ip = (c: Parameters<RemoteAddress>[0]) =>
    clientIp(c.req.raw.headers, config.trustProxy, services.remoteAddress?.(c))
  const sessionDeps = { allowedHosts: config.allowedHosts, loginLimiter, ip, logger }
  return (
    new Hono<AppEnv>()
      .use('*', requestId())
      .use('*', requestContext())
      .use('*', requestLogger(logger, ip))
      .use('*', secureHeaders({ contentSecurityPolicy: CONTENT_SECURITY_POLICY, referrerPolicy: 'same-origin' }))
      .use('/api/*', csrf())
      .onError((err, c) => errorResponse(c, err, logger))
      // Liveness: the process answers. Readiness: the session store is usable.
      .get('/healthz', (c) => c.json({ ok: true }))
      .get('/readyz', async (c) => {
        try {
          await services.store.ping()
          return c.json({ ok: true })
        } catch (err) {
          logger.log('error', 'readyz.failed', { error: err instanceof Error ? err.message : String(err) })
          return c.json({ ok: false }, 503)
        }
      })
      .get('/api/health', (c) => c.json({ ok: true }))
      .get('/api/servers', (c) => c.json(config.servers))
      .route('/api', sessionRoutes(cfg, sessionDeps))
      .route('/api', databaseRoutes(cfg, logger))
      .route('/api', userRoutes(cfg))
      .route('/api', serverRoutes(cfg))
  )
}

export type AppType = ReturnType<typeof createApp>
