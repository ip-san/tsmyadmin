import { randomBytes } from 'node:crypto'
import type { DiscoveryDiagnosis, ServerPreset } from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getSignedCookie } from 'hono/cookie'
import { csrf } from 'hono/csrf'
import { createMiddleware } from 'hono/factory'
import { secureHeaders } from 'hono/secure-headers'
import type { AppConfig } from './config.ts'
import { presetEntry } from './lib/allowlist.ts'
import { apiError, errorResponse, notFoundResponse } from './lib/errors.ts'
import { clientIp, createLogger, type Logger, type RemoteAddress, requestLogger } from './lib/logging.ts'
import { RateLimiter } from './lib/rate-limit.ts'
import { requestContext } from './lib/request-context.ts'
import { databaseRoutes } from './routes/databases.ts'
import { secondFactorRoutes } from './routes/second-factor.ts'
import { serverRoutes } from './routes/server.ts'
import { type SessionRouteDeps, sessionRoutes } from './routes/session.ts'
import { snapshotRoutes } from './routes/snapshots.ts'
import { sqlListRoutes } from './routes/sql-lists.ts'
import { storedRoutes } from './routes/stored.ts'
import { trackingRoutes } from './routes/tracking.ts'
import { userGroupRoutes } from './routes/user-groups.ts'
import { userRoutes } from './routes/users.ts'
import { type AppEnv, SESSION_COOKIE } from './session/middleware.ts'
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
  /** WebAuthn challenges (tests replay a recorded passkey answer by fixing them). */
  challenge?: () => Uint8Array
  /** Database containers found on the local Docker daemon (development; see TSMYADMIN_DOCKER_DISCOVERY). */
  discover?: () => Promise<readonly ServerPreset[]>
  /** Why a database container is missing from the list or cannot be reached (development; see TSMYADMIN_DOCKER_DISCOVERY). */
  diagnose?: () => Promise<DiscoveryDiagnosis>
  /** The login of a discovered container, for a one-click sign-in (TSMYADMIN_DOCKER_LOGIN); see SessionRouteDeps. */
  dockerLogin?: NonNullable<SessionRouteDeps['dockerLogin']>
}

/**
 * Content-Security-Policy for the SPA served by this process. CodeMirror injects <style> elements,
 * so inline styles must be allowed; scripts are only ever loaded from our own origin.
 */
export const contentSecurityPolicy = (imageHosts: readonly string[]) => ({
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  // Pictures from other hosts only where the deployment named them (TSMYADMIN_IMAGE_HOSTS).
  imgSrc: ["'self'", 'data:', ...imageHosts],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
})

const KB = 1024
const MB = 1024 * KB
/**
 * Request-body ceilings per route family. The import route sets its own (IMPORT_MAX_BYTES) and is skipped here;
 * SQL scripts may be pasted dumps; everything else is small JSON. Unauthenticated /api/session is the tightest.
 */
function apiBodyLimit(secret: string) {
  const session = bodyLimit({ maxSize: 64 * KB })
  const sql = bodyLimit({ maxSize: 16 * MB })
  const json = bodyLimit({ maxSize: 1 * MB })
  return createMiddleware<AppEnv>(async (c, next) => {
    const path = c.req.path
    if (path === '/api/session') return session(c, next)
    // Chunked bodies are buffered up to the limit before the route's requireSession runs; refuse unauthenticated
    // uploads here so an anonymous client cannot make the process buffer megabytes per request.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !(await getSignedCookie(c, secret, SESSION_COOKIE))) {
      return c.json(apiError('UNAUTHENTICATED', 'Not connected'), 401)
    }
    if (path.endsWith('/import')) return next()
    if (/\/sql(\/stream)?$/.test(path)) return sql(c, next)
    return json(c, next)
  })
}

/** Failed login attempts allowed per IP (across all user names) = LOGIN_RATE_LIMIT × this. */
export const IP_LIMIT_FACTOR = 3

export function createApp(config: AppConfig, services: AppServices) {
  const logger = services.logger ?? createLogger('pretty', () => undefined)
  const cfg = {
    store: services.store,
    secret: config.sessionSecret,
    secure: config.cookieSecure,
    ttlMs: config.sessionTtlMs,
    require2fa: config.require2fa,
    imageHosts: config.imageHosts,
  }
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
  const allowedHosts = [...new Set([...config.allowedHosts, ...config.servers.map(presetEntry)])]
  const secureTransport = (c: Context) => {
    let url: URL
    try {
      url = new URL(c.req.url)
    } catch {
      return false // a malformed Host header is not a reason for a 500
    }
    if (url.protocol === 'https:') return true
    // X-Forwarded-Proto: the first value is the client-facing hop (unlike X-Forwarded-For, where the last is trusted).
    if (config.trustProxy !== 'none' && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https')
      return true
    // Browsers accept a Secure cookie from http://localhost (Chrome, Firefox; not Safari) — judged by the Host the
    // browser used, which is what the cookie rule looks at.
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  }
  const now = services.now ?? Date.now
  const secondFactorDeps = {
    ipLimiter,
    ip,
    logger,
    now,
    passkey: config.passkey,
    challenge: services.challenge ?? (() => new Uint8Array(randomBytes(32))),
  }
  const sessionDeps = {
    allowedHosts,
    ...(services.discover ? { discovered: services.discover } : {}),
    ...(services.dockerLogin ? { dockerLogin: services.dockerLogin } : {}),
    loginLimiter,
    ipLimiter,
    ip,
    secureTransport,
    logger,
    now,
    secondFactor: secondFactorDeps,
  }
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
      .use(
        '*',
        secureHeaders({
          contentSecurityPolicy: contentSecurityPolicy(config.imageHosts),
          referrerPolicy: 'same-origin',
        })
      )
      .use('/api/*', csrf())
      // Row values and the login target are as sensitive as the credentials behind them: no store may keep a
      // copy — not the browser's disk cache, not an intermediary that ignores the Cookie header.
      .use('/api/*', async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
      })
      .use('/api/*', apiBodyLimit(config.sessionSecret))
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
      .get('/api/servers', async (c) => {
        const found = services.discover ? await services.discover() : []
        const named = new Set(config.servers.map((s) => s.name))
        return c.json([...config.servers, ...found.filter((s) => !named.has(s.name))])
      })
      .get('/api/servers/diagnosis', async (c) =>
        c.json(
          services.diagnose
            ? await services.diagnose()
            : ({
                enabled: false,
                connectHost: '',
                unavailable: null,
                found: 0,
                issues: [],
              } satisfies DiscoveryDiagnosis)
        )
      )
      .route('/api', sessionRoutes(cfg, sessionDeps))
      .route('/api', secondFactorRoutes(cfg, secondFactorDeps))
      .route('/api', databaseRoutes(cfg, logger))
      .route('/api', userRoutes(cfg))
      .route('/api', serverRoutes(cfg, logger))
      .route('/api', storedRoutes(cfg))
      .route('/api', sqlListRoutes(cfg))
      .route('/api', userGroupRoutes(cfg, logger))
      .route('/api', trackingRoutes(cfg, logger))
      .route('/api', snapshotRoutes(cfg, logger))
      // Unknown /api paths get the JSON envelope (registered last, before index.ts adds the SPA fallback for `*`).
      .all('/api/*', (c) => notFoundResponse(c))
  )
}

export type AppType = ReturnType<typeof createApp>
