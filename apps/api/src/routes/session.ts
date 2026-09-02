import { createHash } from 'node:crypto'
import { ConnectRequestSchema } from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { isHostAllowed } from '../lib/allowlist.ts'
import { apiError, errorResponse } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
import type { RateLimiter } from '../lib/rate-limit.ts'
import { validate } from '../lib/validate.ts'
import {
  type AppEnv,
  requireSession,
  SESSION_COOKIE,
  type SessionConfig,
  sessionCookieOptions,
} from '../session/middleware.ts'
import { type Session, sessionInfo } from '../session/store.ts'

export interface SessionRouteDeps {
  allowedHosts: readonly string[]
  /** Per ip|user window (reset on success). */
  loginLimiter: RateLimiter
  /** Coarser per-IP window of *failed* attempts so rotating the user name cannot bypass the limit. */
  ipLimiter: RateLimiter
  /** Client IP resolver shared with the access log. */
  ip: (c: Context) => string
  logger: Logger
}

/** Log-safe session reference: a truncated hash, so logs plus the signing secret cannot forge a cookie. */
function sessionTag(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16)
}

/** Session response: identity plus the namespace usable for server-level SQL/DDL (SessionState). */
function sessionState(session: Session) {
  return { ...sessionInfo(session), serverDatabase: session.adapter.serverNamespace.database }
}

export function sessionRoutes(cfg: SessionConfig, deps: SessionRouteDeps) {
  return new Hono<AppEnv>()
    .post('/session', validate('json', ConnectRequestSchema), async (c) => {
      const body = c.req.valid('json')
      const ip = deps.ip(c)
      const rateKey = `${ip}|${body.user}`
      const audit = {
        requestId: c.get('requestId'),
        ip,
        dialect: body.dialect,
        host: body.host,
        port: body.port,
        user: body.user,
      }

      // The IP limiter counts failures only (a shared office NAT must not be locked out by successful logins).
      // It is checked first so a blocked client cannot grow the ip|user map with fresh user names.
      const perIp = deps.ipLimiter.peek(ip)
      const limit = perIp.allowed ? deps.loginLimiter.hit(rateKey) : { allowed: false, retryAfterSec: 0 }
      if (!perIp.allowed || !limit.allowed) {
        deps.logger.log('warn', 'login.rate_limited', audit)
        c.header('Retry-After', String(Math.max(limit.retryAfterSec, perIp.retryAfterSec)))
        return c.json(apiError('RATE_LIMITED', 'Too many login attempts; try again later'), 429)
      }
      if (!isHostAllowed(body.host, body.port, deps.allowedHosts)) {
        deps.logger.log('warn', 'login.host_not_allowed', audit)
        return c.json(
          apiError('FORBIDDEN', `Connections to "${body.host}:${body.port}" are not allowed (TSMYADMIN_ALLOWED_HOSTS)`),
          403
        )
      }

      // A browser that logs in again without logging out must not keep its previous session (and pools) alive.
      const previous = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
      if (previous) await cfg.store.delete(previous)
      let session: Awaited<ReturnType<typeof cfg.store.create>>
      try {
        // The store builds the (audited) adapter, pings it and persists the session in one step.
        session = await cfg.store.create(body)
      } catch (err) {
        deps.ipLimiter.hit(ip)
        deps.logger.log('warn', 'login.failed', audit)
        return errorResponse(c, err, deps.logger)
      }
      deps.loginLimiter.reset(rateKey)
      deps.logger.log('info', 'login.ok', { ...audit, sessionId: sessionTag(session.id) })
      await setSignedCookie(c, SESSION_COOKIE, session.id, cfg.secret, sessionCookieOptions(cfg))
      return c.json(sessionState(session), 201)
    })
    .get('/session', requireSession(cfg), (c) => c.json(sessionState(c.get('session'))))
    .delete('/session', async (c) => {
      const id = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
      if (id) {
        await cfg.store.delete(id)
        deps.logger.log('info', 'logout', { requestId: c.get('requestId'), sessionId: sessionTag(id) })
      }
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.json({ ok: true })
    })
}
