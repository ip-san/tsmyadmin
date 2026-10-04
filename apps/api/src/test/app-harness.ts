import { readFileSync } from 'node:fs'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { afterEach } from 'vitest'
import { createApp } from '../app.ts'
import { type AppConfig, loadConfig } from '../config.ts'
import { type Logger, type TrustProxy } from '../lib/logging.ts'
import { MemorySessionStore } from '../session/store.ts'

const SECRET = 'test-secret'
export const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'root', password: 'pw' }

/**
 * A passkey registration and four sign-ins (signature counter 2 to 5) recorded from Chrome's virtual authenticator
 * on http://localhost:3199, all against a challenge of 32 bytes of 9: the tests fix the challenge to replay them.
 */
export const PASSKEY_FIXTURE = JSON.parse(
  readFileSync(new URL('../lib/passkey.fixture.json', import.meta.url), 'utf8')
) as {
  origin: string
  rpId: string
  registration: Record<string, unknown>
  assertions: (Record<string, unknown> & { response: Record<string, string> })[]
}

export function fixtureAdapter(overrides: ConstructorParameters<typeof FakeAdapter>[0] = {}) {
  return new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable(
            'users',
            ['id', 'name'],
            [
              { id: 1, name: 'Alice' },
              { id: 2, name: 'Bob' },
              { id: 3, name: 'Carol' },
            ]
          ),
          posts: fakeTable('posts', ['id', 'title'], [{ id: 1, title: 'hello' }]),
        },
      },
      other: { tables: {} },
    },
    ...overrides,
  })
}

interface HarnessOptions {
  allowedHosts?: string[]
  isProd?: boolean
  loginRateLimit?: { max: number; windowMs: number }
  now?: () => number
  trustProxy?: TrustProxy
  remoteAddress?: (c: { req: { header: (name: string) => string | undefined } }) => string | undefined
  servers?: AppConfig['servers']
  logger?: Logger
  discover?: () => Promise<AppConfig['servers']>
}

/** Development defaults from loadConfig, overridden per test. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), sessionSecret: SECRET, allowedHosts: ['db', '127.0.0.1'], ...overrides }
}

export function harness(adapter: FakeAdapter = fixtureAdapter(), options: HarnessOptions = {}) {
  const store = new MemorySessionStore({ adapterFactory: () => adapter, sweepIntervalMs: 0 })
  const app = createApp(
    testConfig({
      ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
      ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}),
      ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
      ...(options.servers ? { servers: options.servers } : {}),
      ...(options.isProd !== undefined ? { isProd: options.isProd, cookieSecure: options.isProd } : {}),
    }),
    {
      store,
      ...(options.now ? { now: options.now } : {}),
      ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.discover ? { discover: options.discover } : {}),
    }
  )
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
    })
  const login = async (body: Record<string, unknown> = LOGIN, headers: Record<string, string> = {}) => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body), headers })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    return res
  }
  return { app, store, adapter, req, login, cookie: () => cookie }
}

/**
 * The stores the tests of a file opened, closed after each test. A test that logs in pushes its store here:
 * `const stores = closeStoresAfterEach()`, then `stores.push(h.store)`.
 */
export function closeStoresAfterEach(): MemorySessionStore[] {
  const stores: MemorySessionStore[] = []
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.closeAll()
  })
  return stores
}
