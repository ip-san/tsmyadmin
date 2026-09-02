import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import { secureHeaders } from 'hono/secure-headers'
import type { AppConfig } from './config.ts'
import { errorResponse, notFoundResponse } from './lib/errors.ts'
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

const KB = 1024
const MB = 1024 * KB
/**
 * Request-body ceilings per route family. The import route sets its own (IMPORT_MAX_BYTES) and is skipped here;
 * SQL scripts may be pasted dumps; everything else is small JSON. Unauthenticated /api/session is the tightest.
 */
function apiBodyLimit() {
  const session = bodyLimit({ maxSize: 64 * KB })
  const sql = bodyLimit({ maxSize: 16 * MB })
  const json = bodyLimit({ maxSize: 1 * MB })
  return createMiddleware<AppEnv>((c, next) => {
    const path = c.req.path
    if (path.endsWith('/import')) return next()
    if (path === '/api/session') return session(c, next)
    if (/\/sql(\/stream)?$/.test(path)) return sql(c, next)
    return json(c, next)
  })
}

/** Failed login attempts allowed per IP (across all user names) = LOGIN_RATE_LIMIT × this. */
export const IP_LIMIT_FACTOR = 3

export function createApp(config: AppConfig, services: AppServices) {
  const logger = services.logger ?? createLogger('pretty', () => undefined)
  const cfg = { store: services.store, secret: config.sessionSecret, secure: config.isProd, ttlMs: config.sessionTtlMs }
  const loginLimiter = new RateLimiter(config.loginRateLimit.max, config.loginRateLimit.windowMs, services.now)
  // Rotating the user name must not grant a fresh window: a second limiter keyed on the IP alone, IP_LIMIT_FACTOR×.
  const ipLimiter = new RateLimiter(
    config.loginRateLimit.max * IP_LIMIT_FACTOR,
    config.loginRateLimit.windowMs,
    services.now
  )
  const ip = (c: Parameters<RemoteAddress>[0]) =>
    clientIp(c.req.raw.headers, config.trustProxy, services.remoteAddress?.(c))
  // Presets are always reachable on exactly their own host:port, however the config object was assembled.
  const allowedHosts = [...new Set([...config.allowedHosts, ...config.servers.map((s) => `${s.host}:${s.port}`)])]
  const sessionDeps = { allowedHosts, loginLimiter, ipLimiter, ip, logger }
  return (
    new Hono<AppEnv>()
      // Always server-generated: a client-supplied X-Request-Id could reuse another request's id in the audit log.
      .use('*', async (c, next) => {
        const id = crypto.randomUUID()
        c.set('requestId', id)
        c.header('X-Request-Id', id)
        await next()
      })
      .use('*', requestContext())
      .use('*', requestLogger(logger, ip))
      .use('*', secureHeaders({ contentSecurityPolicy: CONTENT_SECURITY_POLICY, referrerPolicy: 'same-origin' }))
      .use('/api/*', csrf())
      .use('/api/*', apiBodyLimit())
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
      // Unknown /api paths get the JSON envelope (registered last, before index.ts adds the SPA fallback for `*`).
      .all('/api/*', (c) => notFoundResponse(c))
  )
}

export type AppType = ReturnType<typeof createApp>
