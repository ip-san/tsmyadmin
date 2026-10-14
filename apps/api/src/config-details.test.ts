import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.ts'

/**
 * The boundaries and exact wording of each environment variable's validation. A start-up check that lets a wrong value
 * through (a port of 0, a second factor with a store that forgets it) shows only in production, so each limit is pinned
 * on both sides (found as surviving mutants; see `bun run mutation`).
 */

const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) }
const message = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env)
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError)
    expect((e as Error).name).toBe('ConfigError')
    return (e as Error).message
  }
  return null
}

describe('numbers: accepted on the boundary, refused one past it', () => {
  it('API_PORT is 1..65535 and a whole number', () => {
    expect(loadConfig({ API_PORT: '1' }).port).toBe(1)
    expect(loadConfig({ API_PORT: '65535' }).port).toBe(65535)
    for (const bad of ['0', '65536', '-1', '80.5', 'x'])
      expect(message({ API_PORT: bad }), bad).toMatch(/^Invalid environment: API_PORT: /)
  })

  it('SESSION_TTL_MINUTES is 1..1440 minutes, kept in milliseconds', () => {
    expect(loadConfig({ SESSION_TTL_MINUTES: '1' }).sessionTtlMs).toBe(60_000)
    expect(loadConfig({ SESSION_TTL_MINUTES: '1440' }).sessionTtlMs).toBe(86_400_000)
    for (const bad of ['0', '1441', '1.5'])
      expect(message({ SESSION_TTL_MINUTES: bad }), bad).toMatch(/SESSION_TTL_MINUTES/)
  })

  it('LOGIN_RATE_LIMIT and LOGIN_RATE_WINDOW_SECONDS are whole numbers of at least 1; the window is kept in milliseconds', () => {
    expect(loadConfig({ LOGIN_RATE_LIMIT: '1', LOGIN_RATE_WINDOW_SECONDS: '1' }).loginRateLimit).toEqual({
      max: 1,
      windowMs: 1000,
    })
    for (const name of ['LOGIN_RATE_LIMIT', 'LOGIN_RATE_WINDOW_SECONDS']) {
      expect(message({ [name]: '0' }), name).toMatch(new RegExp(name))
      expect(message({ [name]: '1.5' }), name).toMatch(new RegExp(name))
    }
  })

  it('SESSION_MAX_PER_IDENTITY is 1..1000 (default 10)', () => {
    expect(loadConfig({}).sessionMaxPerIdentity).toBe(10)
    expect(loadConfig({ SESSION_MAX_PER_IDENTITY: '1' }).sessionMaxPerIdentity).toBe(1)
    expect(loadConfig({ SESSION_MAX_PER_IDENTITY: '1000' }).sessionMaxPerIdentity).toBe(1000)
    for (const bad of ['0', '1001', '2.5'])
      expect(message({ SESSION_MAX_PER_IDENTITY: bad }), bad).toMatch(/SESSION_MAX_PER_IDENTITY/)
  })

  it('SHUTDOWN_TIMEOUT_SECONDS is 0..600 (default 30), kept in milliseconds; 0 means do not wait', () => {
    expect(loadConfig({}).shutdownTimeoutMs).toBe(30_000)
    expect(loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '0' }).shutdownTimeoutMs).toBe(0)
    expect(loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '5' }).shutdownTimeoutMs).toBe(5000)
    expect(loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '600' }).shutdownTimeoutMs).toBe(600_000)
    for (const bad of ['-1', '601', '1.5'])
      expect(message({ SHUTDOWN_TIMEOUT_SECONDS: bad }), bad).toMatch(/SHUTDOWN_TIMEOUT_SECONDS/)
  })

  it('IMPORT_MAX_CONCURRENT is 1..32 (default 2)', () => {
    expect(loadConfig({}).importMaxConcurrent).toBe(2)
    expect(loadConfig({ IMPORT_MAX_CONCURRENT: '1' }).importMaxConcurrent).toBe(1)
    expect(loadConfig({ IMPORT_MAX_CONCURRENT: '32' }).importMaxConcurrent).toBe(32)
    for (const bad of ['0', '33', '1.5'])
      expect(message({ IMPORT_MAX_CONCURRENT: bad }), bad).toMatch(/IMPORT_MAX_CONCURRENT/)
  })
})

describe('defaults and enums', () => {
  it('has the documented defaults', () => {
    expect(loadConfig({})).toMatchObject({
      isProd: false,
      require2fa: false,
      passkey: null,
      port: 3100,
      sessionStore: 'memory',
      sessionDbPath: 'data/sessions.sqlite',
      redisUrl: undefined,
      webDist: undefined,
      sessionTtlMs: 1_800_000,
      logFormat: 'pretty',
      trustProxy: 'none',
      cookieSecure: false,
      sessionSecret: 'dev-secret-do-not-use-in-production',
      imageHosts: [],
      dockerDiscovery: null,
      servers: [],
      allowedHosts: ['127.0.0.1', 'localhost'],
    })
  })

  it('passes SESSION_SECRET, paths and URLs through as written', () => {
    expect(
      loadConfig({
        SESSION_SECRET: 'abc',
        SESSION_DB_PATH: '/var/lib/s.sqlite',
        WEB_DIST: 'apps/web/dist',
        SESSION_STORE: 'redis',
        REDIS_URL: 'redis://r:6379',
      })
    ).toMatchObject({
      sessionSecret: 'abc',
      sessionDbPath: '/var/lib/s.sqlite',
      webDist: 'apps/web/dist',
      redisUrl: 'redis://r:6379',
    })
  })

  it('accepts only the listed NODE_ENV values', () => {
    for (const v of ['development', 'test']) expect(loadConfig({ NODE_ENV: v }).isProd).toBe(false)
    expect(loadConfig(prod).isProd).toBe(true)
    expect(message({ NODE_ENV: 'staging' })).toMatch(/^Invalid environment: NODE_ENV/)
  })

  it('accepts every listed SESSION_STORE, LOG_FORMAT and TRUST_PROXY, and refuses the rest', () => {
    expect(loadConfig({ SESSION_STORE: 'memory' }).sessionStore).toBe('memory')
    expect(loadConfig({ SESSION_STORE: 'sqlite' }).sessionStore).toBe('sqlite')
    expect(message({ SESSION_STORE: 'file' })).toMatch(/SESSION_STORE/)
    expect(loadConfig({ LOG_FORMAT: 'json' }).logFormat).toBe('json')
    expect(loadConfig({ LOG_FORMAT: 'pretty', ...prod }).logFormat).toBe('pretty')
    expect(loadConfig({ TRUST_PROXY: '0' }).trustProxy).toBe('none')
    expect(message({ COOKIE_SECURE: 'true' })).toMatch(/COOKIE_SECURE/)
    expect(message({ TSMYADMIN_REQUIRE_2FA: 'true', SESSION_STORE: 'sqlite' })).toMatch(/TSMYADMIN_REQUIRE_2FA/)
  })

  it('COOKIE_SECURE: secure by default only in production, and an explicit value wins either way', () => {
    expect(loadConfig({}).cookieSecure).toBe(false)
    expect(loadConfig(prod).cookieSecure).toBe(true)
    expect(loadConfig({ COOKIE_SECURE: '1' }).cookieSecure).toBe(true)
    expect(loadConfig({ ...prod, COOKIE_SECURE: '0' }).cookieSecure).toBe(false)
  })

  it('PORT is the fallback only when API_PORT is not set, and an empty value counts as not set', () => {
    expect(loadConfig({ PORT: '9000' }).port).toBe(9000)
    expect(loadConfig({ API_PORT: '', PORT: '9000' }).port).toBe(9000)
    expect(loadConfig({ API_PORT: '9100', PORT: '' }).port).toBe(9100)
    expect(loadConfig({ API_PORT: '', PORT: '' }).port).toBe(3100)
    expect(message({ PORT: 'x' })).toMatch(/API_PORT/)
  })

  it('the error lists every problem, each as "name: reason", separated by "; "', () => {
    expect(message({ API_PORT: '0', LOGIN_RATE_LIMIT: '0' })).toMatch(
      /^Invalid environment: API_PORT: .+; LOGIN_RATE_LIMIT: .+$/
    )
  })
})

describe('the rules between variables', () => {
  it('requires a SESSION_SECRET of 32 characters in production, not 31', () => {
    expect(message({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(31) })).toBe(
      'Invalid environment: SESSION_SECRET must be set to at least 32 characters in production'
    )
    expect(loadConfig(prod).sessionSecret).toBe('x'.repeat(32))
    expect(loadConfig({ SESSION_SECRET: 'x' }).sessionSecret).toBe('x')
  })

  it('TSMYADMIN_REQUIRE_2FA needs a store that survives a restart', () => {
    expect(message({ TSMYADMIN_REQUIRE_2FA: '1' })).toBe(
      'Invalid environment: TSMYADMIN_REQUIRE_2FA needs SESSION_STORE=sqlite or redis (the secrets live there)'
    )
    expect(message({ TSMYADMIN_REQUIRE_2FA: '1', SESSION_STORE: 'memory' })).toMatch(/needs SESSION_STORE/)
    expect(loadConfig({ TSMYADMIN_REQUIRE_2FA: '1', SESSION_STORE: 'sqlite' }).require2fa).toBe(true)
    expect(loadConfig({ TSMYADMIN_REQUIRE_2FA: '1', SESSION_STORE: 'redis', REDIS_URL: 'redis://r' }).require2fa).toBe(
      true
    )
    // In production the default store is sqlite, so that is enough.
    expect(loadConfig({ ...prod, TSMYADMIN_REQUIRE_2FA: '1' }).require2fa).toBe(true)
    expect(loadConfig({ TSMYADMIN_REQUIRE_2FA: '0' }).require2fa).toBe(false)
    expect(loadConfig({}).require2fa).toBe(false)
  })

  it('passkeys need a store that survives a restart', () => {
    expect(message({ TSMYADMIN_PASSKEY_ORIGIN: 'https://db.example.com' })).toBe(
      'Invalid environment: TSMYADMIN_PASSKEY_ORIGIN needs SESSION_STORE=sqlite or redis (the passkeys live there)'
    )
    expect(loadConfig({ ...prod, TSMYADMIN_PASSKEY_ORIGIN: 'https://db.example.com' }).passkey?.rpId).toBe(
      'db.example.com'
    )
  })

  it('REDIS_URL is required for SESSION_STORE=redis only', () => {
    expect(message({ SESSION_STORE: 'redis' })).toBe(
      'Invalid environment: REDIS_URL must be set when SESSION_STORE=redis'
    )
    expect(loadConfig({ SESSION_STORE: 'sqlite' }).redisUrl).toBeUndefined()
  })
})

describe('TSMYADMIN_ALLOWED_HOSTS', () => {
  it('keeps the hosts trimmed and once each (a preset repeating a listed entry counts once)', () => {
    expect(loadConfig({ TSMYADMIN_ALLOWED_HOSTS: 'a, a ,b' }).allowedHosts).toEqual(['a', 'b'])
    const servers = JSON.stringify([{ name: 'p', dialect: 'mysql', host: 'h', port: 3306 }])
    expect(loadConfig({ TSMYADMIN_ALLOWED_HOSTS: 'h:3306', TSMYADMIN_SERVERS: servers }).allowedHosts).toEqual([
      'h:3306',
    ])
  })

  it('brackets an IPv6 preset host so its port parses', () => {
    const servers = JSON.stringify([{ name: 'p', dialect: 'postgres', host: '::1', port: 5432 }])
    expect(loadConfig({ TSMYADMIN_ALLOWED_HOSTS: 'x', TSMYADMIN_SERVERS: servers }).allowedHosts).toEqual([
      'x',
      '[::1]:5432',
    ])
  })

  it('says to list at least one host, and which entries are wrong', () => {
    expect(message({ TSMYADMIN_ALLOWED_HOSTS: '' })).toBe(
      'Invalid environment: TSMYADMIN_ALLOWED_HOSTS must list at least one host (or "*")'
    )
    expect(message({ TSMYADMIN_ALLOWED_HOSTS: 'db:abc,ok,h:70000' })).toBe(
      'Invalid environment: TSMYADMIN_ALLOWED_HOSTS: invalid entry db:abc, h:70000 (expected host, host:port or [ipv6]:port with a numeric port)'
    )
  })
})

describe('TSMYADMIN_IMAGE_HOSTS', () => {
  it('lowercases, trims and drops empty entries', () => {
    expect(loadConfig({ TSMYADMIN_IMAGE_HOSTS: ' IMG.Example.COM ,, *.CDN.example.com ' }).imageHosts).toEqual([
      'img.example.com',
      '*.cdn.example.com',
    ])
  })

  it('accepts a host name, an IPv4 address, a leading *. and a port, and refuses what is not a host', () => {
    for (const ok of ['a', 'a.b', 'a-b.c', '10.0.0.1', '*.a.b', 'a:1', 'a:12345', 'a1', '1a'])
      expect(loadConfig({ TSMYADMIN_IMAGE_HOSTS: ok }).imageHosts, ok).toEqual([ok])
    for (const bad of [
      '-a',
      'a-',
      'a..b',
      '.a',
      'a.',
      '*a',
      '**.a',
      'a:',
      'a:123456',
      'a:b',
      'a b',
      'a_b',
      '*.',
      'a:1:2',
    ])
      expect(message({ TSMYADMIN_IMAGE_HOSTS: bad }), bad).toMatch(
        /^Invalid environment: TSMYADMIN_IMAGE_HOSTS: invalid entry /
      )
  })

  it('names every bad entry and says what is expected', () => {
    expect(message({ TSMYADMIN_IMAGE_HOSTS: 'ok.com,*,a b' })).toBe(
      'Invalid environment: TSMYADMIN_IMAGE_HOSTS: invalid entry *, a b (expected host or *.host, optionally with :port)'
    )
  })
})

describe('TSMYADMIN_SERVERS', () => {
  const one = (extra: object = {}) => JSON.stringify([{ name: 'a', dialect: 'mysql', host: 'h', port: 3306, ...extra }])

  it('refuses non-JSON and a JSON that is not a list of presets, naming the field', () => {
    expect(message({ TSMYADMIN_SERVERS: '{oops' })).toBe('Invalid environment: TSMYADMIN_SERVERS must be a JSON array')
    expect(message({ TSMYADMIN_SERVERS: '{"name":"a"}' })).toMatch(/^Invalid environment: TSMYADMIN_SERVERS: /)
    expect(message({ TSMYADMIN_SERVERS: '[{"name":"a","dialect":"oracle","host":"h","port":1}]' })).toMatch(
      /^Invalid environment: TSMYADMIN_SERVERS: 0\.dialect: /
    )
  })

  it('lists every invalid preset, separated by "; "', () => {
    const two = JSON.stringify([
      { name: 'a', dialect: 'oracle', host: 'h', port: 1 },
      { name: 'b', dialect: 'oracle', host: 'h', port: 1 },
    ])
    expect(message({ TSMYADMIN_SERVERS: two })).toMatch(/0\.dialect: .+; 1\.dialect: /)
  })

  it('names the duplicate preset and the one that tries to set autoLogin', () => {
    const dup = JSON.stringify([
      { name: 'a', dialect: 'mysql', host: 'h', port: 1 },
      { name: 'a', dialect: 'mysql', host: 'h', port: 2 },
    ])
    expect(message({ TSMYADMIN_SERVERS: dup })).toBe(
      'Invalid environment: TSMYADMIN_SERVERS: duplicate preset name "a"'
    )
    expect(message({ TSMYADMIN_SERVERS: one({ autoLogin: true }) })).toBe(
      'Invalid environment: TSMYADMIN_SERVERS: "a": autoLogin is set by Docker discovery, not here'
    )
  })

  it('keeps the presets as written', () => {
    expect(loadConfig({ TSMYADMIN_SERVERS: one({ database: 'app' }) }).servers).toEqual([
      { name: 'a', dialect: 'mysql', host: 'h', port: 3306, database: 'app' },
    ])
  })
})

describe('Docker discovery', () => {
  const dev = { TSMYADMIN_DOCKER_DISCOVERY: '1' }

  it('has the documented messages', () => {
    expect(message({ ...prod, ...dev })).toBe(
      'Invalid environment: TSMYADMIN_DOCKER_DISCOVERY is for development only (it reads the Docker socket); it cannot be used with NODE_ENV=production'
    )
    expect(message({ TSMYADMIN_DOCKER_LOGIN: '1' })).toBe(
      'Invalid environment: TSMYADMIN_DOCKER_LOGIN needs TSMYADMIN_DOCKER_DISCOVERY=1 (it signs in to the containers discovery finds)'
    )
    expect(message({ TSMYADMIN_DOCKER_LOGIN: '1', TSMYADMIN_DOCKER_DISCOVERY: '0' })).toMatch(
      /needs TSMYADMIN_DOCKER_DISCOVERY=1/
    )
  })

  it('signs in only for "1", and production is fine while discovery is off', () => {
    expect(loadConfig({ ...dev, TSMYADMIN_DOCKER_LOGIN: '0' }).dockerDiscovery?.login).toBe(false)
    expect(loadConfig({ ...prod, TSMYADMIN_DOCKER_DISCOVERY: '0' }).dockerDiscovery).toBeNull()
    expect(loadConfig({ ...prod, TSMYADMIN_DOCKER_LOGIN: '0' }).dockerDiscovery).toBeNull()
  })
})

describe('the passkey origin', () => {
  const sqlite = { SESSION_STORE: 'sqlite' }
  const origin = (v: string) => message({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: v })
  const rp = (v: string) => loadConfig({ ...sqlite, TSMYADMIN_PASSKEY_ORIGIN: v }).passkey

  it('says what is wrong, in the words of the docs', () => {
    expect(origin('nope')).toBe(
      'Invalid environment: TSMYADMIN_PASSKEY_ORIGIN must be a URL such as https://db.example.com'
    )
    expect(origin('https://a.com/x')).toBe(
      'Invalid environment: TSMYADMIN_PASSKEY_ORIGIN must be an origin only (scheme, host and port; no path)'
    )
    expect(origin('https://a.com?x=1')).toMatch(/origin only/)
    expect(origin('http://a.com')).toBe(
      'Invalid environment: TSMYADMIN_PASSKEY_ORIGIN must use https (http is allowed for localhost only)'
    )
    expect(origin('https://1.2.3.4')).toBe(
      'Invalid environment: TSMYADMIN_PASSKEY_ORIGIN must name a host, not an IP address'
    )
    expect(origin('https://1.2.3.4:8443')).toMatch(/not an IP address/)
    expect(origin('https://[::1]')).toMatch(/not an IP address/)
  })

  it('takes https anywhere and http on localhost only, with a port or one trailing slash', () => {
    expect(rp('https://a.com:8443')).toEqual({ origin: 'https://a.com:8443', rpId: 'a.com' })
    expect(rp('https://a.com/')).toEqual({ origin: 'https://a.com', rpId: 'a.com' })
    expect(rp('http://localhost')).toEqual({ origin: 'http://localhost', rpId: 'localhost' })
    expect(rp('https://localhost:3198')).toEqual({ origin: 'https://localhost:3198', rpId: 'localhost' })
    expect(origin('http://localhost.evil.com')).toMatch(/must use https/)
    // Only plain HTTP is allowed on localhost, not any other scheme that happens to name it.
    expect(origin('ws://localhost')).toMatch(/must use https/)
    expect(origin('ftp://localhost')).toMatch(/must use https/)
    expect(origin('https://a.com//')).toMatch(/origin only/)
  })

  it('only a host made of digits and dots is an IP address: a name that merely starts or ends with digits is a host', () => {
    expect(rp('https://123.example.com')?.rpId).toBe('123.example.com')
    expect(rp('https://db.example1')?.rpId).toBe('db.example1')
    expect(rp('https://a1.example.com')?.rpId).toBe('a1.example.com')
  })
})
