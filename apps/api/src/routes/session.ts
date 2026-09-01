import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema } from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { isHostAllowed } from '../lib/allowlist.ts'
import { apiError, errorResponse } from '../lib/errors.ts'
import { clientIp, type Logger } from '../lib/logging.ts'
import type { RateLimiter } from '../lib/rate-limit.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, SESSION_COOKIE, type SessionConfig } from '../session/middleware.ts'
import { sessionInfo } from '../session/store.ts'

export type AdapterFactory = (config: ConnectRequest) => DatabaseAdapter

export interface SessionRouteDeps {
  adapterFactory: AdapterFactory
  allowedHosts: readonly string[]
  loginLimiter: RateLimiter
  trustProxy: boolean
  logger: Logger
}

export function sessionRoutes(cfg: SessionConfig, deps: SessionRouteDeps) {
  return new Hono<AppEnv>()
    .post('/session', validate('json', ConnectRequestSchema), async (c) => {
      const body = c.req.valid('json')
      const ip = clientIp(c.req.raw.headers, deps.trustProxy)
      const audit = {
        requestId: c.get('requestId'),
        ip,
        dialect: body.dialect,
        host: body.host,
        port: body.port,
        user: body.user,
      }

      const limit = deps.loginLimiter.hit(`${ip}|${body.user}`)
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

      const adapter = deps.adapterFactory(body)
      try {
        await adapter.ping()
      } catch (err) {
        await adapter.close().catch(() => undefined)
        deps.logger.log('warn', 'login.failed', audit)
        return errorResponse(c, err)
      }
      deps.loginLimiter.reset(`${ip}|${body.user}`)
      const session = await cfg.store.create(body, adapter)
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
