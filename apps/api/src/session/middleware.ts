import { getSignedCookie, setSignedCookie } from 'hono/cookie'
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

/** Cookie attributes shared by login and the per-request refresh. */
export function sessionCookieOptions(cfg: SessionConfig) {
  return {
    httpOnly: true,
    sameSite: 'Strict' as const,
    secure: cfg.secure,
    path: '/',
    maxAge: Math.floor(cfg.ttlMs / 1000),
  }
}

export function requireSession(cfg: SessionConfig) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = await getSignedCookie(c, cfg.secret, SESSION_COOKIE)
    const session = id ? await cfg.store.get(id) : undefined
    if (!session || !id) return c.json(apiError('UNAUTHENTICATED', 'Not connected'), 401)
    c.set('session', session)
    // The store's TTL slides on every access; re-issue the cookie so its maxAge slides with it.
    await setSignedCookie(c, SESSION_COOKIE, id, cfg.secret, sessionCookieOptions(cfg))
    await next()
  })
}
