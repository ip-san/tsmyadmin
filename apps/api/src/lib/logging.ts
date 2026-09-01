import type { MiddlewareHandler } from 'hono'

export type LogFormat = 'json' | 'pretty'
type LogLevel = 'info' | 'warn' | 'error'
type LogFields = Record<string, unknown>

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void
}

/**
 * Structured logger: one JSON object per line in production (for log shippers), a readable line in development.
 * Never pass credentials or row values as fields.
 */
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
      const rest = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
      sink(`${time} ${level.toUpperCase().padEnd(5)} ${event}${rest ? ` ${rest}` : ''}`)
    },
  }
}

/** Access log with request id and latency; the id is also returned as X-Request-Id for correlation. */
export function requestLogger(logger: Logger, trustProxy: boolean): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now()
    const requestId = c.get('requestId') as string | undefined
    await next()
    logger.log(c.res.status >= 500 ? 'error' : 'info', 'http', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      ip: clientIp(c.req.raw.headers, trustProxy),
    })
  }
}

/** Client IP for rate limiting / logs. Only honours X-Forwarded-For when a reverse proxy is declared trusted. */
export function clientIp(headers: Headers, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = headers.get('x-forwarded-for')
    const first = xff?.split(',')[0]?.trim()
    if (first) return first
  }
  return headers.get('x-real-ip') ?? 'unknown'
}
