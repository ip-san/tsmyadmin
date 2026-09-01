import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema } from '@tsmyadmin/shared'
import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { errorResponse } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { type AppEnv, requireSession, SESSION_COOKIE, type SessionConfig } from '../session/middleware.ts'
import { SESSION_TTL_MS, sessionInfo } from '../session/store.ts'

export type AdapterFactory = (config: ConnectRequest) => DatabaseAdapter

export function sessionRoutes(cfg: SessionConfig, adapterFactory: AdapterFactory) {
  return new Hono<AppEnv>()
    .post('/session', validate('json', ConnectRequestSchema), async (c) => {
      const body = c.req.valid('json')
      const adapter = adapterFactory(body)
      try {
        await adapter.ping()
      } catch (err) {
        await adapter.close().catch(() => undefined)
        return errorResponse(c, err)
      }
      const session = cfg.store.create(body, adapter)
      await setSignedCookie(c, SESSION_COOKIE, session.id, cfg.secret, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: cfg.secure,
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      })
      return c.json(sessionInfo(session), 201)
    })
    .get('/session', requireSession(cfg), (c) => c.json(sessionInfo(c.get('session'))))
    .delete('/session', async (c) => {
      const id = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
      if (id) await cfg.store.delete(id)
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.json({ ok: true })
    })
}
