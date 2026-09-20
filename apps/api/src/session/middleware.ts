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
  /** Every account must have a second factor: one that has not enrolled may only enrol (TSMYADMIN_REQUIRE_2FA). */
  require2fa?: boolean
  /** Hosts an image link may load pictures from (TSMYADMIN_IMAGE_HOSTS). */
  imageHosts?: string[]
}

/** Whether this account still has to enrol before it may do anything else. */
async function enrolmentRequired(cfg: SessionConfig, session: Session): Promise<boolean> {
  if (!cfg.require2fa) return false
  return (await cfg.store.secondFactor?.get(session.config)) === null || cfg.store.secondFactor === undefined
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
    // Where a second factor is required and this account has none, the session exists but may only enrol: the
    // alternative — refusing the login — would leave nobody able to enrol at all.
    if (await enrolmentRequired(cfg, session)) {
      return c.json(apiError('SECOND_FACTOR_REQUIRED', 'Enrol a second factor before using this connection'), 401)
    }
    await next()
  })
}
