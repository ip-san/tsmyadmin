import { existsSync } from 'node:fs'
import path from 'node:path'
import { createAdapter } from '@tsmyadmin/adapter'
import { serveStatic } from 'hono/bun'
import { createApp } from './app.ts'
import { ConfigError, loadConfig } from './config.ts'
import { createLogger } from './lib/logging.ts'
import { MemorySessionStore } from './session/store.ts'

export type { AppType } from './app.ts'

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env)
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err)
  process.exit(1)
}
const logger = createLogger(config.logFormat)
if (!process.env.SESSION_SECRET)
  logger.log('warn', 'config.dev_secret', { hint: 'SESSION_SECRET not set; using a development secret' })

const store = new MemorySessionStore({ ttlMs: config.sessionTtlMs })
const app = createApp({
  adapterFactory: createAdapter,
  store,
  secret: config.sessionSecret,
  secure: config.isProd,
  sessionTtlMs: config.sessionTtlMs,
  allowedHosts: config.allowedHosts,
  loginRateLimit: config.loginRateLimit,
  trustProxy: config.trustProxy,
  logger,
})

// hono/bun serveStatic resolves paths relative to the process cwd (it prefixes "./"), so keep this relative.
const webDist = config.webDist ?? path.relative(process.cwd(), path.resolve(import.meta.dir, '../../web/dist'))
if (existsSync(webDist)) {
  app.use('*', serveStatic({ root: webDist }))
  app.get('*', serveStatic({ path: path.join(webDist, 'index.html') }))
} else {
  logger.log('warn', 'web.dist_missing', { webDist })
}

const shutdown = async (signal: string) => {
  logger.log('info', 'shutdown', { signal })
  await store.closeAll()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

logger.log('info', 'startup', {
  port: config.port,
  env: config.isProd ? 'production' : 'development',
  allowedHosts: config.allowedHosts,
  sessionTtlMinutes: config.sessionTtlMs / 60_000,
})

export default {
  port: config.port,
  fetch: app.fetch,
}
