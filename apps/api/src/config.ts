import { type ServerPreset, ServerPresetsSchema } from '@tsmyadmin/shared'
import { z } from 'zod'

const formatIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)

/**
 * Process configuration, validated once at startup. Every variable is documented in docs/deployment.md
 * (the single source of truth for the env table); .env.example mirrors the defaults.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  /** Signs the session cookie. Required (≥ 32 chars) in production. */
  SESSION_SECRET: z.string().default(''),
  /** Sliding session TTL. */
  SESSION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(30),
  /**
   * Database hosts the login form may connect to. Comma-separated; entries are exact hosts, `*.suffix`
   * wildcards, or `*` to allow anything. This is the main SSRF/pivot control — keep it tight in production.
   */
  TSMYADMIN_ALLOWED_HOSTS: z.string().default('127.0.0.1,localhost'),
  /**
   * JSON array of connection presets shown on the login screen, e.g.
   * [{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}].
   * Preset hosts are allowed automatically. Never put passwords here.
   */
  TSMYADMIN_SERVERS: z.string().optional(),
  /** Login attempts allowed per client IP + user within the window. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy in front of the API. */
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  /** `json` (one object per line, for log shippers) or `pretty` (development). */
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  /** `sqlite` keeps sessions across restarts (credentials encrypted with a key derived from SESSION_SECRET); `memory` does not. */
  SESSION_STORE: z.enum(['memory', 'sqlite']).optional(),
  SESSION_DB_PATH: z.string().default('data/sessions.sqlite'),
  /** Directory of the built SPA served by the API (relative to the working directory). */
  WEB_DIST: z.string().optional(),
  /** Live sessions per database account (dialect/host/port/user); the least recently used is evicted beyond it. */
  SESSION_MAX_PER_IDENTITY: z.coerce.number().int().min(1).max(1000).default(10),
  /** On SIGTERM/SIGINT: stop accepting requests, wait up to this long for in-flight ones, then exit. */
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
})

export type AppConfig = {
  isProd: boolean
  port: number
  sessionSecret: string
  sessionTtlMs: number
  allowedHosts: string[]
  servers: ServerPreset[]
  loginRateLimit: { max: number; windowMs: number }
  trustProxy: boolean
  logFormat: 'json' | 'pretty'
  sessionStore: 'memory' | 'sqlite'
  sessionDbPath: string
  webDist: string | undefined
  shutdownTimeoutMs: number
  sessionMaxPerIdentity: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${formatIssues(parsed.error)}`)
  }
  const e = parsed.data
  const isProd = e.NODE_ENV === 'production'
  if (isProd && e.SESSION_SECRET.length < 32) {
    throw new ConfigError('SESSION_SECRET must be set to at least 32 characters in production')
  }
  const servers = parseServers(e.TSMYADMIN_SERVERS)
  // Presets allow exactly their own host:port (not every port on that host).
  const allowedHosts = [...new Set([...csv(e.TSMYADMIN_ALLOWED_HOSTS), ...servers.map((s) => `${s.host}:${s.port}`)])]
  if (allowedHosts.length === 0) throw new ConfigError('TSMYADMIN_ALLOWED_HOSTS must list at least one host (or "*")')
  return {
    isProd,
    port: e.API_PORT,
    sessionSecret: e.SESSION_SECRET || 'dev-secret-do-not-use-in-production',
    sessionTtlMs: e.SESSION_TTL_MINUTES * 60_000,
    allowedHosts,
    servers,
    loginRateLimit: { max: e.LOGIN_RATE_LIMIT, windowMs: e.LOGIN_RATE_WINDOW_SECONDS * 1000 },
    trustProxy: e.TRUST_PROXY === '1',
    logFormat: e.LOG_FORMAT ?? (isProd ? 'json' : 'pretty'),
    sessionStore: e.SESSION_STORE ?? (isProd ? 'sqlite' : 'memory'),
    sessionDbPath: e.SESSION_DB_PATH,
    webDist: e.WEB_DIST,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    sessionMaxPerIdentity: e.SESSION_MAX_PER_IDENTITY,
  }
}

function parseServers(raw: string | undefined): ServerPreset[] {
  if (!raw || raw.trim() === '') return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ConfigError('TSMYADMIN_SERVERS must be a JSON array')
  }
  const parsed = ServerPresetsSchema.safeParse(json)
  if (!parsed.success) {
    throw new ConfigError(
      `TSMYADMIN_SERVERS: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    )
  }
  const names = new Set<string>()
  for (const s of parsed.data) {
    if (names.has(s.name)) throw new ConfigError(`TSMYADMIN_SERVERS: duplicate preset name "${s.name}"`)
    names.add(s.name)
  }
  return parsed.data
}
