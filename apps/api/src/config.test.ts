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
      trustProxy: 'none',
      cookieSecure: false,
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
      trustProxy: 'forwarded',
      cookieSecure: false,
    })
    // PORT (platform-injected) is the fallback for API_PORT; COOKIE_SECURE overrides the NODE_ENV default.
    expect(loadConfig({ PORT: '9000' }).port).toBe(9000)
    expect(loadConfig({ PORT: '9000', API_PORT: '9100' }).port).toBe(9100)
    expect(loadConfig({ COOKIE_SECURE: '1' }).cookieSecure).toBe(true)
    expect(
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), COOKIE_SECURE: '0' }).cookieSecure
    ).toBe(false)
    expect(() => loadConfig({ TSMYADMIN_ALLOWED_HOSTS: 'db:abc' })).toThrow(/invalid entry db:abc/)
    expect(() => loadConfig({ TSMYADMIN_ALLOWED_HOSTS: '::1:5432' })).toThrow(/invalid entry/)
    expect(loadConfig({ TSMYADMIN_ALLOWED_HOSTS: '[::1]:5432,db' }).allowedHosts).toEqual(['[::1]:5432', 'db'])
    expect(() => loadConfig({ API_PORT: 'eighty' })).toThrow(/API_PORT/)
    expect(() => loadConfig({ TSMYADMIN_ALLOWED_HOSTS: ' , ' })).toThrow(/ALLOWED_HOSTS/)
    expect(() => loadConfig({ LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT/)
  })
})

describe('empty values', () => {
  it('treats an empty TSMYADMIN_ALLOWED_HOSTS as "presets only" instead of the default hosts', () => {
    const config = loadConfig({
      TSMYADMIN_ALLOWED_HOSTS: '',
      TSMYADMIN_SERVERS: '[{"name":"p","dialect":"postgres","host":"db.internal","port":5432}]',
    })
    expect(config.allowedHosts).toEqual(['db.internal:5432'])
    expect(() => loadConfig({ TSMYADMIN_ALLOWED_HOSTS: '' })).toThrow(/^Invalid environment: TSMYADMIN_ALLOWED_HOSTS/)
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
    // Unknown keys (a password, a typo) are rejected rather than silently dropped.
    expect(() =>
      loadConfig({ TSMYADMIN_SERVERS: '[{"name":"x","dialect":"mysql","host":"h","port":1,"password":"p"}]' })
    ).toThrow(/password/)
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

  it('refuses SESSION_STORE=redis without a URL to connect to', () => {
    expect(() => loadConfig({ SESSION_STORE: 'redis' })).toThrow(/REDIS_URL/)
    expect(loadConfig({ SESSION_STORE: 'redis', REDIS_URL: 'redis://r:6379' })).toMatchObject({
      sessionStore: 'redis',
      redisUrl: 'redis://r:6379',
    })
    // An empty value counts as unset here as everywhere else, so it is refused rather than passed to the client.
    expect(() => loadConfig({ SESSION_STORE: 'redis', REDIS_URL: '' })).toThrow(/REDIS_URL/)
  })

  it('names Cloudflare as the trusted proxy when asked', () => {
    expect(loadConfig({ TRUST_PROXY: 'cloudflare' })).toMatchObject({ trustProxy: 'cloudflare' })
    expect(loadConfig({ TRUST_PROXY: '1' })).toMatchObject({ trustProxy: 'forwarded' })
    expect(loadConfig({})).toMatchObject({ trustProxy: 'none' })
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/)
  })
})

describe('TSMYADMIN_PASSKEY_ORIGIN', () => {
  const sqlite = { SESSION_STORE: 'sqlite' as const }

  it('binds passkeys to the configured origin and its host name', () => {
    expect(loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: 'https://db.example.com' }).passkey).toEqual({
      origin: 'https://db.example.com',
      rpId: 'db.example.com',
    })
    expect(loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: 'http://localhost:3198/' }).passkey).toEqual({
      origin: 'http://localhost:3198',
      rpId: 'localhost',
    })
    expect(loadConfig({}).passkey).toBeNull()
  })

  it('refuses what a browser would not accept, and a store that could not keep the passkeys', () => {
    // Plain HTTP is allowed on localhost only; an IP address cannot be a relying party; a path is not an origin.
    expect(() => loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: 'http://db.example.com' })).toThrow(/https/)
    expect(() => loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: 'https://10.0.0.5' })).toThrow(/IP address/)
    expect(() => loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: 'https://db.example.com/app' })).toThrow(
      /origin only/
    )
    expect(() => loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: 'db.example.com' })).toThrow(/URL/)
    expect(() => loadConfig({ TSMYADMIN_PASSKEY_ORIGIN: 'https://db.example.com' })).toThrow(/SESSION_STORE/)
  })
})
