import { getSignedCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { apiError } from '../lib/errors.ts'
import type { Session, SessionStore } from './store.ts'

export const SESSION_COOKIE = 'tsmyadmin_session'

export interface AppEnv {
  Variables: { session: Session; requestId: string }
}

export interface SessionConfig {
  store: SessionStore
  secret: string
  secure: boolean
  ttlMs: number
}

export function requireSession(cfg: SessionConfig) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
    const session = id ? await cfg.store.get(id) : undefined
    if (!session) return c.json(apiError('UNAUTHENTICATED', 'Not connected'), 401)
    c.set('session', session)
    await next()
  })
}
