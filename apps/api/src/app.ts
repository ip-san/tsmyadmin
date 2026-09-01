import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { errorResponse } from './lib/errors.ts'
import { databaseRoutes } from './routes/databases.ts'
import { type AdapterFactory, sessionRoutes } from './routes/session.ts'
import { userRoutes } from './routes/users.ts'
import type { SessionStore } from './session/store.ts'

export interface AppDeps {
  adapterFactory: AdapterFactory
  store: SessionStore
  secret: string
  /** Mark the session cookie Secure (production behind HTTPS). */
  secure: boolean
}

export function createApp(deps: AppDeps) {
  const cfg = { store: deps.store, secret: deps.secret, secure: deps.secure }
  return new Hono()
    .use('/api/*', csrf())
    .onError((err, c) => errorResponse(c, err))
    .get('/api/health', (c) => c.json({ ok: true }))
    .route('/api', sessionRoutes(cfg, deps.adapterFactory))
    .route('/api', databaseRoutes(cfg))
    .route('/api', userRoutes(cfg))
}

export type AppType = ReturnType<typeof createApp>
