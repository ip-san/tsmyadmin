import { existsSync } from 'node:fs'
import path from 'node:path'
import { createAdapter } from '@tsmyadmin/adapter'
import { serveStatic } from 'hono/bun'
import { logger } from 'hono/logger'
import { createApp } from './app.ts'
import { MemorySessionStore } from './session/store.ts'

export type { AppType } from './app.ts'

const isProd = process.env.NODE_ENV === 'production'
const secret = process.env.SESSION_SECRET ?? ''
if (!secret) {
  if (isProd) throw new Error('SESSION_SECRET is required in production')
  console.warn('[api] SESSION_SECRET not set; using a development secret')
}

const store = new MemorySessionStore()
const app = createApp({
  adapterFactory: createAdapter,
  store,
  secret: secret || 'dev-secret-do-not-use-in-production',
  secure: isProd,
})

app.use(logger())

const webDist = process.env.WEB_DIST ?? path.resolve(import.meta.dir, '../../web/dist')
if (existsSync(webDist)) {
  app.use('*', serveStatic({ root: webDist }))
  app.get('*', serveStatic({ path: path.join(webDist, 'index.html') }))
}

const shutdown = async () => {
  await store.closeAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export default {
  port: Number(process.env.API_PORT ?? 3100),
  fetch: app.fetch,
}
