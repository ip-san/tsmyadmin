import type { Context, MiddlewareHandler } from 'hono'

export type LogFormat = 'json' | 'pretty'
type LogLevel = 'info' | 'warn' | 'error'
type LogFields = Record<string, unknown>

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void
}

/** Resolves the socket's remote address (runtime-specific; Bun: getConnInfo). */
export type RemoteAddress = (c: Context) => string | undefined

/**
 * Structured logger: one JSON object per line in production (for log shippers), a readable line in development.
 * Never pass credentials or row values as fields.
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

export function createLogger(
  format: LogFormat,
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)
): Logger {
  return {
    log(level, event, fields = {}) {
      const time = new Date().toISOString()
      if (format === 'json') {
        sink(JSON.stringify({ time, level, event, ...fields }))
        return
      }
      // Strings carrying control characters (paths, user names) are quoted so a request cannot forge log lines.
      const rest = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' && !hasControlChars(v) ? v : JSON.stringify(v)}`)
        .join(' ')
      sink(`${time} ${level.toUpperCase().padEnd(5)} ${event}${rest ? ` ${rest}` : ''}`)
    },
  }
}

/** Liveness / readiness probes fire every few seconds; a successful probe is not worth an access-log line. */
const PROBE_PATHS = new Set(['/healthz', '/readyz'])

/** Access log with request id and latency; the id is also returned as X-Request-Id for correlation. */
export function requestLogger(logger: Logger, ip: (c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now()
    const requestId = c.get('requestId') as string | undefined
    await next()
    if (PROBE_PATHS.has(c.req.path) && c.res.status < 400) return
    // Hashed asset downloads are not operations worth a line each (cached a year on the client anyway).
    if (c.req.path.startsWith('/assets/') && c.res.status < 400) return
    logger.log(c.res.status >= 500 ? 'error' : 'info', 'http', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      ip: ip(c),
    })
  }
}

/** Which hop, if any, is allowed to tell us who the client is. */
export type TrustProxy = 'none' | 'forwarded' | 'cloudflare'

/**
 * Client IP for rate limiting / logs. The socket address is the source of truth; X-Forwarded-For is honoured
 * only when a reverse proxy is declared trusted, and then only its LAST element: proxies append the address they
 * saw, so the last entry is the one written by the trusted hop while earlier entries are whatever the client
 * sent.
 *
 * `cloudflare` additionally reads CF-Connecting-IP, which Cloudflare overwrites on every request that passes
 * through it. It is a separate setting rather than part of `forwarded` because that guarantee only holds behind
 * Cloudflare: anywhere else the header is one a client can simply set, and trusting it would hand every client
 * a way to pick its own rate-limit bucket.
 */
export function clientIp(headers: Headers, trustProxy: TrustProxy, remote: string | undefined): string {
  if (trustProxy === 'cloudflare') {
    const cf = headers.get('cf-connecting-ip')?.trim()
    if (cf) return stripPort(cf)
  }
  if (trustProxy !== 'none') {
    const last = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
    if (last) return stripPort(last)
  }
  return remote ? stripPort(remote) : 'unknown'
}

/**
 * Drops a source port some proxies append (Azure App Service writes `1.2.3.4:56789`).
 *
 * Keeping it would be quiet and bad: the port changes on every TCP connection, so each attempt would land in a
 * rate-limit bucket of its own and the per-IP login limit would stop counting anything.
 *
 * Bare IPv6 is left alone — `2001:db8::1` is not an address with a port, and there is no way to tell one from the
 * other except by counting colons. Only the bracketed form carries a port.
 */
function stripPort(value: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketed?.[1]) return bracketed[1]
  const withPort = /^([^:]+):\d+$/.exec(value)
  if (withPort?.[1]) return withPort[1]
  return value
}
