import { ConnectRequestSchema } from '@tsmyadmin/shared'
import { type Context, Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { isHostAllowed } from '../lib/allowlist.ts'
import { apiError, errorResponse } from '../lib/errors.ts'
import type { Logger } from '../lib/logging.ts'
import type { RateLimiter } from '../lib/rate-limit.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, SESSION_COOKIE, type SessionConfig } from '../session/middleware.ts'
import { sessionInfo } from '../session/store.ts'

export interface SessionRouteDeps {
  allowedHosts: readonly string[]
  loginLimiter: RateLimiter
  /** Client IP resolver shared with the access log. */
  ip: (c: Context) => string
  logger: Logger
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

      const limit = deps.loginLimiter.hit(rateKey)
      if (!limit.allowed) {
        deps.logger.log('warn', 'login.rate_limited', audit)
        c.header('Retry-After', String(limit.retryAfterSec))
        return c.json(apiError('RATE_LIMITED', 'Too many login attempts; try again later'), 429)
      }
      if (!isHostAllowed(body.host, deps.allowedHosts)) {
        deps.logger.log('warn', 'login.host_not_allowed', audit)
        return c.json(
          apiError('FORBIDDEN', `Connections to "${body.host}" are not allowed (TSMYADMIN_ALLOWED_HOSTS)`),
          403
        )
      }

      let session: Awaited<ReturnType<typeof cfg.store.create>>
      try {
        // The store builds the (audited) adapter, pings it and persists the session in one step.
        session = await cfg.store.create(body)
      } catch (err) {
        deps.logger.log('warn', 'login.failed', audit)
        return errorResponse(c, err, deps.logger)
      }
      deps.loginLimiter.reset(rateKey)
      deps.logger.log('info', 'login.ok', { ...audit, sessionId: session.id })
      await setSignedCookie(c, SESSION_COOKIE, session.id, cfg.secret, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: cfg.secure,
        path: '/',
        maxAge: Math.floor(cfg.ttlMs / 1000),
      })
      return c.json(sessionInfo(session), 201)
    })
    .get('/session', requireSession(cfg), (c) => c.json(sessionInfo(c.get('session'))))
    .delete('/session', async (c) => {
      const id = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
      if (id) {
        await cfg.store.delete(id)
        deps.logger.log('info', 'logout', { requestId: c.get('requestId'), sessionId: id })
      }
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.json({ ok: true })
    })
}
