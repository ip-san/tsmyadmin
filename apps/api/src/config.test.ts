import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('applies development defaults', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({
      isProd: false,
      port: 3100,
      sessionTtlMs: 30 * 60_000,
      allowedHosts: ['127.0.0.1', 'localhost'],
      loginRateLimit: { max: 10, windowMs: 60_000 },
      trustProxy: false,
      logFormat: 'pretty',
      servers: [],
      sessionStore: 'memory',
      sessionDbPath: 'data/sessions.sqlite',
    })
    expect(c.sessionSecret.length).toBeGreaterThan(0)
  })

  it('requires a strong SESSION_SECRET in production and defaults to json logs', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/)
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/)
    const c = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) })
    expect(c.isProd).toBe(true)
    expect(c.logFormat).toBe('json')
    expect(c.sessionStore).toBe('sqlite')
    expect(
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), SESSION_STORE: 'memory' }).sessionStore
    ).toBe('memory')
  })

  it('parses and validates numbers and lists', () => {
    const c = loadConfig({
      API_PORT: '8080',
      SESSION_TTL_MINUTES: '5',
      TSMYADMIN_ALLOWED_HOSTS: ' db.internal , *.rds.amazonaws.com ',
      LOGIN_RATE_LIMIT: '3',
      LOGIN_RATE_WINDOW_SECONDS: '10',
      TRUST_PROXY: '1',
    })
    expect(c).toMatchObject({
      port: 8080,
      sessionTtlMs: 300_000,
      allowedHosts: ['db.internal', '*.rds.amazonaws.com'],
      loginRateLimit: { max: 3, windowMs: 10_000 },
      trustProxy: true,
    })
    expect(() => loadConfig({ API_PORT: 'eighty' })).toThrow(/API_PORT/)
    expect(() => loadConfig({ TSMYADMIN_ALLOWED_HOSTS: ' , ' })).toThrow(/ALLOWED_HOSTS/)
    expect(() => loadConfig({ LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT/)
  })
})

describe('.env.example', () => {
  it('loads as-is: every empty value counts as unset and the defaults apply', () => {
    const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
      if (m) env[m[1] ?? ''] = m[2] ?? ''
    }
    expect(Object.keys(env).length).toBeGreaterThan(10)
    const config = loadConfig(env)
    expect(config.isProd).toBe(false)
    expect(config.sessionStore).toBe('memory')
    expect(config.logFormat).toBe('pretty')
    expect(config.webDist).toBeUndefined()
    expect(config.servers).toEqual([])
  })
})

describe('TSMYADMIN_SERVERS', () => {
  it('parses presets and allows their hosts automatically', () => {
    const c = loadConfig({
      TSMYADMIN_SERVERS: JSON.stringify([
        { name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432, database: 'app' },
        { name: 'legacy', dialect: 'mysql', host: 'legacy.internal', port: 3306 },
      ]),
    })
    expect(c.servers).toHaveLength(2)
    // Presets allow exactly their own host:port.
    expect(c.allowedHosts).toEqual(['127.0.0.1', 'localhost', 'db.internal:5432', 'legacy.internal:3306'])
  })

  it('rejects malformed JSON, invalid presets and duplicate names', () => {
    expect(() => loadConfig({ TSMYADMIN_SERVERS: '{oops' })).toThrow(/JSON array/)
    expect(() => loadConfig({ TSMYADMIN_SERVERS: '[{"name":"x","dialect":"oracle","host":"h","port":1}]' })).toThrow(
      /dialect/
    )
    expect(() =>
      loadConfig({
        TSMYADMIN_SERVERS:
          '[{"name":"a","dialect":"mysql","host":"h","port":1},{"name":"a","dialect":"mysql","host":"h","port":2}]',
      })
    ).toThrow(/duplicate/)
    expect(loadConfig({ TSMYADMIN_SERVERS: '  ' }).servers).toEqual([])
  })
})
