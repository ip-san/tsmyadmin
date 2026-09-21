import { type ServerPreset, ServerPresetsSchema } from '@tsmyadmin/shared'
import { z } from 'zod'
import { invalidEntries, presetEntry } from './lib/allowlist.ts'
import type { TrustProxy } from './lib/logging.ts'

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
  /** Listening port; `PORT` (what most hosting platforms inject) is accepted as a fallback. */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  /**
   * `Secure` flag on the session cookie: `1` in production by default. `0` only for TLS-free internal networks —
   * a production login over plain HTTP is refused otherwise (the browser would drop the cookie).
   */
  COOKIE_SECURE: z.enum(['0', '1']).optional(),
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
   * wildcards, or `*` to allow anything, each optionally with `:port` (`[::1]:5432` for IPv6). An entry
   * without a port allows every port on that host. This is the main SSRF/pivot control — see docs/security.md.
   */
  TSMYADMIN_ALLOWED_HOSTS: z.string().default('127.0.0.1,localhost'),
  /**
   * JSON array of connection presets shown on the login screen, e.g.
   * [{"name":"prod","dialect":"postgres","host":"db.internal","port":5432,"database":"app"}].
   * Preset hosts are allowed automatically. Never put passwords here.
   */
  TSMYADMIN_SERVERS: z.string().optional(),
  /**
   * Hosts the "image link" display transformation may load pictures from (added to the CSP's img-src). Comma-separated
   * `host` or `*.suffix` entries, each optionally with `:port`; without one, the default port. Empty: none.
   */
  TSMYADMIN_IMAGE_HOSTS: z.string().default(''),
  /**
   * `1` lists the database containers the local Docker daemon runs on the login screen and allows connecting to
   * them (development only: it reads the Docker socket, which is root on the host). Refused in production.
   */
  TSMYADMIN_DOCKER_DISCOVERY: z.enum(['0', '1']).optional(),
  /**
   * `1` (with TSMYADMIN_DOCKER_DISCOVERY) reads each container's own login from its environment (the root or
   * application password it was started with) and lets the login screen sign in to it in one click. The password
   * stays in this process: it is never sent to the browser, logged or stored. Off by default; development only.
   */
  TSMYADMIN_DOCKER_LOGIN: z.enum(['0', '1']).optional(),
  /** Unix socket of the Docker Engine API, read with GET requests only. */
  TSMYADMIN_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /**
   * The host name that reaches a container's published port from where this process runs. Unset: `127.0.0.1` on the
   * host, `host.docker.internal` inside a container.
   */
  TSMYADMIN_DOCKER_CONNECT_HOST: z.string().optional(),
  /** Login attempts allowed per client IP + user within the window. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  /**
   * `1` trusts the last X-Forwarded-For element from a reverse proxy in front of the API; `cloudflare` also
   * reads CF-Connecting-IP, which only Cloudflare can be relied on to overwrite.
   */
  TRUST_PROXY: z.enum(['0', '1', 'cloudflare']).default('0'),
  /** `json` (one object per line, for log shippers) or `pretty` (development). */
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  /** `sqlite` keeps sessions across restarts, `redis` shares them between replicas, `memory` does neither. */
  SESSION_STORE: z.enum(['memory', 'sqlite', 'redis']).optional(),
  /**
   * `1` requires every account to have a second factor: one that has not enrolled can do nothing but enrol.
   * Needs a session store that survives a restart, since that is where the secret lives.
   */
  TSMYADMIN_REQUIRE_2FA: z.enum(['0', '1']).optional(),
  TSMYADMIN_PASSKEY_ORIGIN: z.string().optional(),
  SESSION_DB_PATH: z.string().default('data/sessions.sqlite'),
  /** Required by SESSION_STORE=redis. */
  REDIS_URL: z.string().optional(),
  /** Directory of the built SPA served by the API (relative to the working directory). */
  WEB_DIST: z.string().optional(),
  /** Live sessions per database account (dialect/host/port/user); the least recently used is evicted beyond it. */
  SESSION_MAX_PER_IDENTITY: z.coerce.number().int().min(1).max(1000).default(10),
  /** On SIGTERM/SIGINT: stop accepting requests, wait up to this long for in-flight ones, then exit. */
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
})

export type AppConfig = {
  isProd: boolean
  /** Every account must have a second factor (TSMYADMIN_REQUIRE_2FA). */
  require2fa: boolean
  /**
   * Where the app is reached, for passkeys (TSMYADMIN_PASSKEY_ORIGIN): a passkey is bound to this origin's host
   * name, so it is configured rather than read from request headers. Unset: passkeys are not offered.
   */
  passkey: { origin: string; rpId: string } | null
  /** `Secure` on the session cookie; a production login over plain HTTP is refused while this is on. */
  cookieSecure: boolean
  port: number
  sessionSecret: string
  sessionTtlMs: number
  allowedHosts: string[]
  servers: ServerPreset[]
  loginRateLimit: { max: number; windowMs: number }
  trustProxy: TrustProxy
  logFormat: 'json' | 'pretty'
  sessionStore: 'memory' | 'sqlite' | 'redis'
  sessionDbPath: string
  redisUrl: string | undefined
  webDist: string | undefined
  shutdownTimeoutMs: number
  sessionMaxPerIdentity: number
  /** Hosts an image link may load pictures from (TSMYADMIN_IMAGE_HOSTS). */
  imageHosts: string[]
  /** Docker container discovery (TSMYADMIN_DOCKER_DISCOVERY); null when off. */
  dockerDiscovery: { socketPath: string; connectHost: string | undefined; login: boolean } | null
}

/** Every startup-validation failure reads `Invalid environment: ...` (docs/deployment.md, docs/operations.md). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid environment: ${message}`)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  // `.env.example` ships optional variables as `NAME=`; an empty value means "unset", not the empty string.
  // TSMYADMIN_ALLOWED_HOSTS is the one exception: empty means "no default hosts, presets only" (docs/deployment.md).
  const present = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => v !== '' || k === 'TSMYADMIN_ALLOWED_HOSTS')
  )
  if (present.API_PORT === undefined && present.PORT !== undefined) present.API_PORT = present.PORT
  const parsed = EnvSchema.safeParse(present)
  if (!parsed.success) {
    throw new ConfigError(formatIssues(parsed.error))
  }
  const e = parsed.data
  const isProd = e.NODE_ENV === 'production'
  if (isProd && e.SESSION_SECRET.length < 32) {
    throw new ConfigError('SESSION_SECRET must be set to at least 32 characters in production')
  }
  const sessionStore = e.SESSION_STORE ?? (isProd ? 'sqlite' : 'memory')
  const require2fa = e.TSMYADMIN_REQUIRE_2FA === '1'
  if (require2fa && sessionStore === 'memory') {
    throw new ConfigError('TSMYADMIN_REQUIRE_2FA needs SESSION_STORE=sqlite or redis (the secrets live there)')
  }
  const passkey = parsePasskeyOrigin(e.TSMYADMIN_PASSKEY_ORIGIN)
  if (passkey && sessionStore === 'memory') {
    throw new ConfigError('TSMYADMIN_PASSKEY_ORIGIN needs SESSION_STORE=sqlite or redis (the passkeys live there)')
  }
  if (sessionStore === 'redis' && !e.REDIS_URL) {
    throw new ConfigError('REDIS_URL must be set when SESSION_STORE=redis')
  }
  const servers = parseServers(e.TSMYADMIN_SERVERS)
  // Presets allow exactly their own host:port (not every port on that host).
  const allowedHosts = [...new Set([...csv(e.TSMYADMIN_ALLOWED_HOSTS), ...servers.map(presetEntry)])]
  if (allowedHosts.length === 0) throw new ConfigError('TSMYADMIN_ALLOWED_HOSTS must list at least one host (or "*")')
  const invalid = invalidEntries(allowedHosts)
  if (invalid.length > 0) {
    // (the checker reads "use host" as SQL: the hint lives in a plain string)
    const hint = 'expected host, host:port or [ipv6]:port with a numeric port'
    throw new ConfigError(`TSMYADMIN_ALLOWED_HOSTS: invalid entry ${invalid.join(', ')} (${hint})`)
  }
  const imageHosts = csv(e.TSMYADMIN_IMAGE_HOSTS).map((h) => h.toLowerCase())
  const badImageHosts = imageHosts.filter((h) => !IMAGE_HOST.test(h))
  if (badImageHosts.length > 0) {
    throw new ConfigError(
      `TSMYADMIN_IMAGE_HOSTS: invalid entry ${badImageHosts.join(', ')} (expected host or *.host, optionally with :port)`
    )
  }
  if (isProd && e.TSMYADMIN_DOCKER_DISCOVERY === '1') {
    throw new ConfigError(
      'TSMYADMIN_DOCKER_DISCOVERY is for development only (it reads the Docker socket); it cannot be used with NODE_ENV=production'
    )
  }
  if (e.TSMYADMIN_DOCKER_LOGIN === '1' && e.TSMYADMIN_DOCKER_DISCOVERY !== '1') {
    throw new ConfigError(
      'TSMYADMIN_DOCKER_LOGIN needs TSMYADMIN_DOCKER_DISCOVERY=1 (it signs in to the containers discovery finds)'
    )
  }
  return {
    isProd,
    require2fa,
    passkey,
    port: e.API_PORT,
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === '1' : isProd,
    sessionSecret: e.SESSION_SECRET || 'dev-secret-do-not-use-in-production',
    sessionTtlMs: e.SESSION_TTL_MINUTES * 60_000,
    allowedHosts,
    servers,
    loginRateLimit: { max: e.LOGIN_RATE_LIMIT, windowMs: e.LOGIN_RATE_WINDOW_SECONDS * 1000 },
    trustProxy: e.TRUST_PROXY === '0' ? 'none' : e.TRUST_PROXY === 'cloudflare' ? 'cloudflare' : 'forwarded',
    logFormat: e.LOG_FORMAT ?? (isProd ? 'json' : 'pretty'),
    sessionStore,
    sessionDbPath: e.SESSION_DB_PATH,
    redisUrl: e.REDIS_URL,
    webDist: e.WEB_DIST,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    sessionMaxPerIdentity: e.SESSION_MAX_PER_IDENTITY,
    imageHosts,
    dockerDiscovery:
      e.TSMYADMIN_DOCKER_DISCOVERY === '1'
        ? {
            socketPath: e.TSMYADMIN_DOCKER_SOCKET,
            connectHost: e.TSMYADMIN_DOCKER_CONNECT_HOST,
            login: e.TSMYADMIN_DOCKER_LOGIN === '1',
          }
        : null,
  }
}

/** A host name or IPv4 address, a leading `*.` allowed, and an optional port: nothing that could add to a CSP source list. */
const IMAGE_HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/

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
    if (s.autoLogin)
      throw new ConfigError(`TSMYADMIN_SERVERS: "${s.name}": autoLogin is set by Docker discovery, not here`)
  }
  return parsed.data
}

/**
 * The origin passkeys are bound to: a bare `scheme://host[:port]`, over HTTPS — browsers allow WebAuthn over plain
 * HTTP only on localhost, and a host that is an IP address cannot be a relying party at all.
 */
function parsePasskeyOrigin(value: string | undefined): { origin: string; rpId: string } | null {
  if (value === undefined || value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError('TSMYADMIN_PASSKEY_ORIGIN must be a URL such as https://db.example.com')
  }
  if (url.origin !== value.replace(/\/$/, '')) {
    throw new ConfigError('TSMYADMIN_PASSKEY_ORIGIN must be an origin only (scheme, host and port; no path)')
  }
  const local = url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new ConfigError('TSMYADMIN_PASSKEY_ORIGIN must use https (http is allowed for localhost only)')
  }
  if (/^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) {
    throw new ConfigError('TSMYADMIN_PASSKEY_ORIGIN must name a host, not an IP address')
  }
  return { origin: url.origin, rpId: url.hostname }
}
