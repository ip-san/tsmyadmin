import { existsSync } from 'node:fs'
import path from 'node:path'
import { createAdapter } from '@tsmyadmin/adapter'
import { getConnInfo, serveStatic } from 'hono/bun'
import { createApp } from './app.ts'
import { ConfigError, loadConfig } from './config.ts'
import { entriesWithoutPort } from './lib/allowlist.ts'
import { auditedAdapterFactory } from './lib/audit.ts'
import { createLogger } from './lib/logging.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { MemorySessionStore, type SessionStore } from './session/store.ts'

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
const anyPort = entriesWithoutPort(config.allowedHosts)
if (config.isProd && anyPort.length > 0)
  logger.log('warn', 'config.allowlist_without_port', {
    entries: anyPort,
    hint: 'TSMYADMIN_ALLOWED_HOSTS entries without :port allow every port on that host (see docs/security.md)',
  })

// Every adapter a session ever sees goes through this factory, so auditing cannot be bypassed.
const adapterFactory = auditedAdapterFactory(createAdapter, logger)
const store: SessionStore =
  config.sessionStore === 'sqlite'
    ? new SqliteSessionStore({
        path: config.sessionDbPath,
        secret: config.sessionSecret,
        ttlMs: config.sessionTtlMs,
        adapterFactory,
      })
    : new MemorySessionStore({ ttlMs: config.sessionTtlMs, adapterFactory })

const app = createApp(config, {
  store,
  logger,
  remoteAddress: (c) => {
    try {
      return getConnInfo(c).remote.address
    } catch {
      return undefined
    }
  },
})

// hono/bun serveStatic resolves paths relative to the process cwd (it prefixes "./"), so keep this relative.
const webDist = config.webDist ?? path.relative(process.cwd(), path.resolve(import.meta.dir, '../../web/dist'))
if (existsSync(webDist)) {
  app.use('*', serveStatic({ root: webDist }))
  app.get('*', serveStatic({ path: path.join(webDist, 'index.html') }))
} else {
  logger.log('warn', 'web.dist_missing', { webDist })
}

const server = Bun.serve({ port: config.port, fetch: app.fetch })

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests (long SQL, exports, imports) finish
 * within SHUTDOWN_TIMEOUT_SECONDS, then close every session's database pools. A second signal or the deadline
 * forces exit. `/readyz` keeps answering 200 until the listener closes, so drain the load balancer first.
 */
let stopping = false
const shutdown = async (signal: string) => {
  if (stopping) {
    logger.log('warn', 'shutdown.forced', { signal })
    process.exit(1)
  }
  stopping = true
  logger.log('info', 'shutdown.begin', { signal, timeoutMs: config.shutdownTimeoutMs })
  const deadline = setTimeout(() => {
    logger.log('warn', 'shutdown.timeout', { pendingRequests: server.pendingRequests })
    process.exit(1)
  }, config.shutdownTimeoutMs)
  await server.stop() // resolves once active requests have completed
  await store.closeAll()
  clearTimeout(deadline)
  logger.log('info', 'shutdown.done', {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

logger.log('info', 'startup', {
  port: config.port,
  env: config.isProd ? 'production' : 'development',
  allowedHosts: config.allowedHosts,
  sessionStore: config.sessionStore,
  sessionTtlMinutes: config.sessionTtlMs / 60_000,
})
