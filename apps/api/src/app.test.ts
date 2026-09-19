import { readFileSync } from 'node:fs'
import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import {
  AccountSecondFactorsSchema,
  ApiErrorSchema,
  BrowseResultSchema,
  CentralColumnSchema,
  ColumnTransformSchema,
  ConnectRequestSchema,
  DdlPreviewResponseSchema,
  DesignerPageSchema,
  DiagnosticReportSchema,
  ExportTemplateSchema,
  IMPORT_MAX_BYTES,
  ImportEventSchema,
  KeyValueSchema,
  PasskeyChallengeSchema,
  PasskeyRegistrationSchema,
  ProcessInfoSchema,
  QueryBuilderResultSchema,
  QueryTemplateSchema,
  RelationDefSchema,
  ReplicationInfoSchema,
  SAVED_QUERY_MAX_SQL,
  SavedQuerySchema,
  SEARCH_TERM_MAX,
  SecondFactorSetupSchema,
  SecondFactorStatusSchema,
  ServerCatalogSchema,
  ServerInfoSchema,
  SessionStateSchema,
  SqlStreamEventSchema,
  StatementResultSchema,
  TableInfoSchema,
  TableSchemaSchema,
  TableSearchResultSchema,
  TableStatsSchema,
  TRACKING_DEFINITION_MAX,
  TrackingStateSchema,
  UserGroupSchema,
} from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, IP_LIMIT_FACTOR } from './app.ts'
import { type AppConfig, loadConfig } from './config.ts'
import { auditedAdapterFactory } from './lib/audit.ts'
import { createLogger, type Logger, type TrustProxy } from './lib/logging.ts'
import { codeFor, stepAt } from './lib/totp.ts'
import { SAVED_QUERY_LIMIT } from './session/saved-queries.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { MemorySessionStore } from './session/store.ts'

const SECRET = 'test-secret'
const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'root', password: 'pw' }

/**
 * A passkey registration and four sign-ins (signature counter 2 to 5) recorded from Chrome's virtual authenticator
 * on http://localhost:3199, all against a challenge of 32 bytes of 9: the tests fix the challenge to replay them.
 */
const PASSKEY_FIXTURE = JSON.parse(readFileSync(new URL('./lib/passkey.fixture.json', import.meta.url), 'utf8')) as {
  origin: string
  rpId: string
  registration: Record<string, unknown>
  assertions: (Record<string, unknown> & { response: Record<string, string> })[]
}

function fixtureAdapter(overrides: ConstructorParameters<typeof FakeAdapter>[0] = {}) {
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
}

/** Development defaults from loadConfig, overridden per test. */
function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), sessionSecret: SECRET, allowedHosts: ['db', '127.0.0.1'], ...overrides }
}

function harness(adapter: FakeAdapter = fixtureAdapter(), options: HarnessOptions = {}) {
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

const stores: MemorySessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})

describe('session', () => {
  it('logs in, sets an HttpOnly signed cookie and never returns the password', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(201)
    const body = SessionStateSchema.parse(await res.json())
    expect(body).toEqual({
      savedQueries: 'browser',
      // The in-memory store keeps neither bookmarks nor a second factor, and says so rather than offering both.
      secondFactor: 'unsupported',
      dialect: 'mysql',
      host: 'db',
      port: 3306,
      user: 'root',
      serverDatabase: 'information_schema',
    })
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/tsmyadmin_session=/)
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(h.adapter.calls[0]?.method).toBe('ping')
    const me = await h.req('/api/session')
    expect(me.status).toBe(200)
    expect(SessionStateSchema.parse(await me.json()).user).toBe('root')
  })

  it('rejects bad credentials with AUTH_FAILED and closes the adapter', async () => {
    const adapter = fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') })
    const h = harness(adapter)
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(401)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('AUTH_FAILED')
    expect(h.store.size).toBe(0)
  })

  it('never echoes a MySQL host-ACL message (it names the API host) to the login caller', async () => {
    const adapter = fixtureAdapter({
      failWith: new AdapterError(
        'CONNECTION_FAILED',
        "ER_HOST_NOT_PRIVILEGED: Host '10.0.0.7' is not allowed",
        undefined,
        {
          nativeCode: 'ER_HOST_NOT_PRIVILEGED',
        }
      ),
    })
    const h = harness(adapter)
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(502)
    const body = await res.text()
    expect(body).not.toContain("Host '")
    expect(ApiErrorSchema.parse(JSON.parse(body)).code).toBe('CONNECTION_FAILED')
  })

  it('maps unreachable hosts to 502 CONNECTION_FAILED', async () => {
    const h = harness(fixtureAdapter({ failWith: new AdapterError('CONNECTION_FAILED', 'ECONNREFUSED') }))
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(502)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('CONNECTION_FAILED')
  })

  it('validates the login body', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/api/session', { method: 'POST', body: JSON.stringify({ dialect: 'oracle' }) })
    expect(res.status).toBe(400)
    const err = ApiErrorSchema.parse(await res.json())
    expect(err.code).toBe('VALIDATION')
    expect(err.detail).toContain('dialect')
  })

  it('requires a session for data routes and rejects tampered cookies', async () => {
    const h = harness()
    stores.push(h.store)
    expect((await h.req('/api/databases')).status).toBe(401)
    const forged = await h.app.request('/api/databases', { headers: { cookie: 'tsmyadmin_session=abc.def' } })
    expect(forged.status).toBe(401)
  })

  it('logs out, clears the cookie and closes the adapter', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/session', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect(h.adapter.closed).toBe(true)
    expect((await h.req('/api/session')).status).toBe(401)
  })
})

describe('hardening', () => {
  it('refuses hosts outside the allowlist with 403 HOST_NOT_ALLOWED before touching the adapter', async () => {
    const h = harness(fixtureAdapter(), { allowedHosts: ['db.internal', '*.rds.amazonaws.com'] })
    stores.push(h.store)
    const res = await h.login({ ...LOGIN, host: 'evil.example' })
    expect(res.status).toBe(403)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('HOST_NOT_ALLOWED')
    expect(h.adapter.calls).toHaveLength(0)
    expect((await h.login({ ...LOGIN, host: 'prod.rds.amazonaws.com' })).status).toBe(201)
  })

  it('rate-limits login attempts per IP + user and recovers after the window', async () => {
    let t = 0
    const h = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      loginRateLimit: { max: 2, windowMs: 1000 },
      now: () => t,
    })
    stores.push(h.store)
    expect((await h.login()).status).toBe(401)
    expect((await h.login()).status).toBe(401)
    const blocked = await h.login()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('1')
    expect(ApiErrorSchema.parse(await blocked.json()).code).toBe('RATE_LIMITED')
    expect((await h.login({ ...LOGIN, user: 'other' })).status).toBe(401)
    t = 1000
    expect((await h.login()).status).toBe(401)
  })

  it("does not spend the user's login budget on a rejected host, but does count it against the IP", async () => {
    // A mistyped host is a configuration error, not a failed credential: burning the per-user window would lock
    // someone out of their own real login. Probing the allowlist still has to cost something, though — the
    // 403-vs-401 difference tells an unauthenticated caller which hosts exist — so it is counted on the IP.
    const h = harness(fixtureAdapter(), { allowedHosts: ['db'], loginRateLimit: { max: 2, windowMs: 60_000 } })
    stores.push(h.store)
    const denied = { ...LOGIN, host: 'elsewhere.example.com' }
    for (let i = 0; i < 2; i++) expect((await h.login(denied)).status).toBe(403)
    // The user's own window is untouched, so a legitimate login still goes through.
    expect((await h.login()).status).toBe(201)
    // And the IP counter did move: max × IP_LIMIT_FACTOR failures in the window and the next one is refused.
    const h2 = harness(fixtureAdapter(), { allowedHosts: ['db'], loginRateLimit: { max: 2, windowMs: 60_000 } })
    stores.push(h2.store)
    for (let i = 0; i < 2 * IP_LIMIT_FACTOR; i++) expect((await h2.login(denied)).status).toBe(403)
    expect((await h2.login(denied)).status).toBe(429)
  })

  it('rate-limits per IP across rotating user names', async () => {
    const h = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      loginRateLimit: { max: 1, windowMs: 60_000 },
    })
    stores.push(h.store)
    // max 1 per ip|user, IP_LIMIT_FACTOR× per IP: the (factor+1)-th user name from the same IP is refused.
    for (let i = 0; i < IP_LIMIT_FACTOR; i++) expect((await h.login({ ...LOGIN, user: `u${i}` })).status).toBe(401)
    const blocked = await h.login({ ...LOGIN, user: 'fresh-name' })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('60')
  })

  it('does not count successful logins against the per-IP window (shared NAT)', async () => {
    const h = harness(fixtureAdapter(), { loginRateLimit: { max: 1, windowMs: 60_000 } })
    stores.push(h.store)
    for (let i = 0; i < IP_LIMIT_FACTOR * 2; i++) expect((await h.login({ ...LOGIN, user: `ok${i}` })).status).toBe(201)
  })

  it('restricts allowlisted hosts to the listed port and lets presets allow only their own port', async () => {
    const h = harness(fixtureAdapter(), {
      allowedHosts: ['db:3306', '127.0.0.1'],
      servers: [{ name: 'p', dialect: 'mysql', host: 'preset.internal', port: 3307, database: 'x' }],
    })
    stores.push(h.store)
    expect((await h.login({ ...LOGIN, host: 'db', port: 3306 })).status).toBe(201)
    expect((await h.login({ ...LOGIN, host: 'db', port: 22 })).status).toBe(403)
    expect((await h.login({ ...LOGIN, host: '127.0.0.1', port: 9999 })).status).toBe(201)
    expect((await h.login({ ...LOGIN, host: 'preset.internal', port: 3307 })).status).toBe(201)
    expect((await h.login({ ...LOGIN, host: 'preset.internal', port: 3306 })).status).toBe(403)
  })

  it('caps request bodies per route family (tight on the unauthenticated login)', async () => {
    const h = harness()
    stores.push(h.store)
    const big = (n: number) => JSON.stringify({ ...LOGIN, password: 'x'.repeat(n) })
    expect((await h.req('/api/session', { method: 'POST', body: big(70 * 1024) })).status).toBe(413)
    await h.login()
    const sql = (n: number) => JSON.stringify({ sql: `SELECT '${'y'.repeat(n)}'` })
    expect((await h.req('/api/databases/shop/sql', { method: 'POST', body: sql(2 * 1024 * 1024) })).status).toBe(200)
    expect((await h.req('/api/databases/shop/sql', { method: 'POST', body: sql(17 * 1024 * 1024) })).status).toBe(413)
    const rows = JSON.stringify({ values: { name: 'z'.repeat(2 * 1024 * 1024) } })
    expect((await h.req('/api/databases/shop/tables/users/rows', { method: 'POST', body: rows })).status).toBe(413)
  })

  it('re-issues the session cookie on every authenticated request so its expiry slides with the store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/session')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/tsmyadmin_session=.*Max-Age=\d+/)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/)
  })

  it('never returns internal error details to the client', async () => {
    const adapter = fixtureAdapter()
    adapter.listDatabases = async () => {
      throw new TypeError('/srv/app/internal.ts exploded')
    }
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases')
    expect(res.status).toBe(500)
    const body = ApiErrorSchema.parse(await res.json())
    expect(body).toEqual({ code: 'INTERNAL', message: 'Internal error' })
  })

  it('keys the limiter by the socket address and ignores spoofable headers when no proxy is trusted', async () => {
    // The test harness has no socket; simulate the remote address with a header the real resolver never reads.
    const h = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      loginRateLimit: { max: 1, windowMs: 60_000 },
      remoteAddress: (c) => c.req.header('x-test-remote'),
    })
    stores.push(h.store)
    expect((await h.login(LOGIN, { 'x-test-remote': '192.0.2.1' })).status).toBe(401)
    expect((await h.login(LOGIN, { 'x-test-remote': '192.0.2.2' })).status).toBe(401)
    expect(
      (
        await h.login(LOGIN, {
          'x-test-remote': '192.0.2.1',
          'x-real-ip': '198.51.100.9',
          'x-forwarded-for': '203.0.113.5',
        })
      ).status
    ).toBe(429)
  })

  it('keys the limiter by X-Forwarded-For only when the proxy is trusted', async () => {
    const trusted = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      loginRateLimit: { max: 1, windowMs: 60_000 },
      trustProxy: 'forwarded',
    })
    stores.push(trusted.store)
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(401)
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(401)
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429)
    // A client-forged first element does not open a new window: only the proxy-appended last element counts.
    expect((await trusted.login(LOGIN, { 'x-forwarded-for': '10.9.9.9, 203.0.113.1' })).status).toBe(429)
  })

  it('closes the previous session of a browser that logs in again', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(h.store.size).toBe(1)
    const again = await h.login()
    expect(again.status).toBe(201)
    expect(h.store.size).toBe(1)
    // A failed re-login keeps the current session.
    const cookie = h.cookie()
    expect((await h.login({ ...LOGIN, host: 'evil.example' })).status).toBe(403)
    expect((await h.req('/api/session', { headers: { cookie } })).status).toBe(200)
  })

  it('refuses a production login over plain HTTP from a non-loopback host, accepts TLS via a trusted proxy', async () => {
    const h = harness(fixtureAdapter(), { isProd: true, trustProxy: 'forwarded' })
    stores.push(h.store)
    const post = (url: string, headers: Record<string, string> = {}) =>
      h.app.request(url, {
        method: 'POST',
        body: JSON.stringify(LOGIN),
        headers: { 'content-type': 'application/json', ...headers },
      })
    // app.request() defaults to http://localhost: loopback is fine; a real host over http is not.
    const plain = await post('http://admin.example.com/api/session')
    expect(plain.status).toBe(400)
    expect(((await plain.json()) as { code: string }).code).toBe('INSECURE_TRANSPORT')
    const proxied = await post('http://admin.example.com/api/session', { 'x-forwarded-proto': 'https' })
    expect(proxied.status).toBe(201)
    const https = await post('https://admin.example.com/api/session')
    expect(https.status).toBe(201)
  })

  it('marks the session cookie Secure in production and slides Max-Age to the TTL', async () => {
    const h = harness(fixtureAdapter(), { isProd: true })
    stores.push(h.store)
    const login = await h.login()
    expect(login.headers.get('set-cookie')).toMatch(/; Secure/)
    expect(login.headers.get('set-cookie')).toMatch(/Max-Age=1800/)
    const res = await h.req('/api/session')
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=1800/)
    expect(res.headers.get('set-cookie')).toMatch(/; Secure/)
  })

  it('refuses unauthenticated non-GET bodies before buffering them', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.app.request('/api/databases/shop/sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    })
    expect(res.status).toBe(401)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('UNAUTHENTICATED')
  })

  it('allows an IPv6 preset on exactly its port', async () => {
    const h = harness(fixtureAdapter(), {
      allowedHosts: ['db'],
      servers: [{ name: 'v6', dialect: 'postgres', host: '::1', port: 5432, database: 'x' }],
    })
    stores.push(h.store)
    expect((await h.login({ ...LOGIN, host: '::1', port: 5432 })).status).toBe(201)
    expect((await h.login({ ...LOGIN, host: '::1', port: 5433 })).status).toBe(403)
  })

  it('maps a framework 403 to a FORBIDDEN envelope', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    // Multipart POST without an Origin header is refused by hono/csrf with 403.
    const fd = new FormData()
    fd.set('format', 'sql')
    const csrf = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie() },
    })
    expect(csrf.status).toBe(403)
    expect(ApiErrorSchema.parse(await csrf.json()).code).toBe('FORBIDDEN')
  })

  it('ignores a client-supplied X-Request-Id', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/healthz', { headers: { 'x-request-id': 'forged-id' } })
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('sets security headers, a request id and answers health probes', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/healthz')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/)
    expect((await h.req('/readyz')).status).toBe(200)
    const broken = new MemorySessionStore({ adapterFactory: () => fixtureAdapter(), sweepIntervalMs: 0 })
    broken.ping = async () => {
      throw new Error('store down')
    }
    const app = createApp(testConfig(), { store: broken })
    expect((await app.request('/readyz')).status).toBe(503)
  })
})

describe('audit log', () => {
  it('records mutating calls with the session identity and never the password being set', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) => [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }],
      users: [],
    })
    const store = new MemorySessionStore({
      adapterFactory: auditedAdapterFactory(() => adapter, logger),
      sweepIntervalMs: 0,
    })
    stores.push(store)
    const app = createApp(testConfig({ allowedHosts: ['db'] }), { store, logger })
    const login = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LOGIN),
    })
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    await app.request('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ keys: [{ kind: 'pk', values: { id: 1 } }] }),
    })
    await app.request('/api/users/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ op: { op: 'setPassword', user: { name: 'x', host: '%' }, password: 'hunter2' } }),
    })
    const audits = lines.filter((l) => l.event === 'audit')
    expect(audits.map((a) => a.action)).toEqual(['deleteRows', 'executeSql'])
    expect(audits[0]).toMatchObject({ dbUser: 'root', dbHost: 'db:3306', table: 'users', rows: 1, ok: true })
    for (const a of audits) expect(String(a.requestId)).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.stringify(lines)).not.toContain('hunter2')
    expect(audits[1]?.sql).toContain('****')
  })
})

describe('server presets', () => {
  it('exposes configured presets without authentication and never credentials', async () => {
    const h = harness(fixtureAdapter(), {
      servers: [{ name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432, database: 'app' }],
    })
    stores.push(h.store)
    const res = await h.app.request('/api/servers')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432, database: 'app' },
    ])
    const none = harness()
    stores.push(none.store)
    expect(await (await none.app.request('/api/servers')).json()).toEqual([])
  })
})

describe('databases & tables', () => {
  it('lists databases, schemas and tables (contract-checked)', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const dbs = (await (await h.req('/api/databases')).json()) as { name: string }[]
    expect(dbs.map((d) => d.name)).toEqual(['other', 'shop'])
    expect(await (await h.req('/api/databases/shop/schemas')).json()).toEqual([])
    const tables = z.array(TableInfoSchema).parse(await (await h.req('/api/databases/shop/tables')).json())
    expect(tables.map((t) => t.name)).toEqual(['users', 'posts'])
    const structure = TableSchemaSchema.parse(await (await h.req('/api/databases/shop/tables/users/structure')).json())
    expect(structure.primaryKey).toEqual(['id'])
  })

  it('lists routines and triggers (table filter passed through)', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/databases/shop/routines?schema=app')).json()).toEqual([])
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listRoutines', args: [{ database: 'shop', schema: 'app' }] })
    expect(await (await h.req('/api/databases/shop/routines/user_label/definition?kind=function')).json()).toEqual({
      definition: 'CREATE FUNCTION user_label() BEGIN END',
    })
    expect(h.adapter.calls.at(-1)).toEqual({
      method: 'routineDefinition',
      args: [{ database: 'shop' }, 'user_label', 'function'],
    })
    expect((await h.req('/api/databases/shop/routines/user_label/definition?kind=view')).status).toBe(400)
    expect(await (await h.req('/api/databases/shop/triggers?table=users')).json()).toEqual([])
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listTriggers', args: [{ database: 'shop' }, 'users'] })
    expect(await (await h.req('/api/databases/shop/events')).json()).toEqual([])
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listEvents', args: [{ database: 'shop' }] })
  })

  it('passes ?schema through as the namespace', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    await h.req('/api/databases/shop/tables?schema=app')
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listTables', args: [{ database: 'shop', schema: 'app' }] })
  })

  it('answers unknown /api paths with the JSON NOT_FOUND envelope', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/api/no/such/route')
    expect(res.status).toBe(404)
    expect(ApiErrorSchema.parse(await res.json())).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the CREATE statements of a table', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/create')
    expect(res.status).toBe(200)
    expect(DdlPreviewResponseSchema.parse(await res.json()).sql[0]).toMatch(/CREATE TABLE/)
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'showCreateTable', args: [{ database: 'shop' }, 'users'] })
  })

  it('returns 404 NOT_FOUND from the adapter', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/nope/structure')
    expect(res.status).toBe(404)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('NOT_FOUND')
  })
})

describe('rows', () => {
  it('browses with sort/filter/paging from the query string', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req(
      '/api/databases/shop/tables/users/rows?limit=2&offset=1&sort=name:desc&filters=' +
        encodeURIComponent('[{"column":"name","op":"like","value":"%o%"}]')
    )
    expect(res.status).toBe(200)
    const body = BrowseResultSchema.parse(await res.json())
    expect(body.rows).toEqual([[2, 'Bob']])
    expect(body.total).toBe(2)
    expect(h.adapter.calls.at(-1)?.args[2]).toEqual({
      offset: 1,
      limit: 2,
      sort: [{ column: 'name', direction: 'desc' }],
      filters: [{ column: 'name', op: 'like', value: '%o%' }],
    })
  })

  it('takes list operators with their values from the query string', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ids = async (filters: unknown) => {
      const res = await h.req(
        `/api/databases/shop/tables/users/rows?sort=id:asc&filters=${encodeURIComponent(JSON.stringify(filters))}`
      )
      expect(res.status).toBe(200)
      return BrowseResultSchema.parse(await res.json()).rows.map((r) => r[0])
    }
    expect(await ids([{ column: 'id', op: 'in', values: [1, '3'] }])).toEqual([1, 3])
    expect(await ids([{ column: 'id', op: 'not_between', values: ['2', 2] }])).toEqual([1, 3])
    expect(await ids([{ column: 'name', op: 'regexp', value: '^[AB]' }])).toEqual([1, 2])
  })

  it("reports a table's space and row statistics", async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/stats')
    expect(res.status).toBe(200)
    expect(TableStatsSchema.parse(await res.json())).toMatchObject({ rowEstimate: 3, dataBytes: 300 })
    expect((await h.req('/api/databases/shop/tables/nope/stats')).status).toBe(404)
  })

  it('hands one value over whole as a download', async () => {
    const h = harness(
      fixtureAdapter({
        databases: {
          shop: {
            tables: {
              files: fakeTable(
                'files',
                ['id', 'data'],
                [
                  { id: 1, data: { $bin: Buffer.from([0, 1, 255]).toString('base64') } },
                  { id: 2, data: null },
                ]
              ),
            },
          },
        },
      })
    )
    stores.push(h.store)
    await h.login()
    const url = (id: unknown, column = 'data') =>
      `/api/databases/shop/tables/files/cell?column=${column}&key=${encodeURIComponent(JSON.stringify(id))}`
    const res = await h.req(url({ kind: 'pk', values: { id: 1 } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('filename="files.data.bin"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 255])
    expect((await h.req(url({ kind: 'pk', values: { id: 2 } }))).status).toBe(404)
    expect((await h.req(url({ kind: 'nope' }))).status).toBe(400)
    expect((await h.req(url({ kind: 'pk', values: { id: 9 } }))).status).toBe(409)
  })

  it('rejects malformed browse parameters', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/databases/shop/tables/users/rows?limit=99999')).status).toBe(400)
    expect((await h.req('/api/databases/shop/tables/users/rows?sort=name:up')).status).toBe(400)
    expect((await h.req('/api/databases/shop/tables/users/rows?filters=nope')).status).toBe(400)
  })

  it('inserts, updates and deletes rows', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ins = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'POST',
      body: JSON.stringify({ values: { id: 4, name: 'Dave' } }),
    })
    expect(ins.status).toBe(201)
    const upd = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: 4 } }, values: { name: 'David' } }),
    })
    expect(await upd.json()).toEqual({ affectedRows: 1 })
    const del = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      body: JSON.stringify({
        keys: [
          { kind: 'pk', values: { id: 4 } },
          { kind: 'pk', values: { id: 3 } },
        ],
      }),
    })
    expect(await del.json()).toEqual({ affectedRows: 2 })
    const rows = BrowseResultSchema.parse(await (await h.req('/api/databases/shop/tables/users/rows')).json())
    expect(rows.rows.map((r) => r[1])).toEqual(['Alice', 'Bob'])
  })

  it('returns 409 KEY_MISMATCH when a key matches no row', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: 99 } }, values: { name: 'x' } }),
    })
    expect(res.status).toBe(409)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('KEY_MISMATCH')
  })

  it('rejects invalid row keys and binary cells that are not base64 objects', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      body: JSON.stringify({ keys: [{ kind: 'magic', values: {} }] }),
    })
    expect(res.status).toBe(400)
    const bad = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'POST',
      body: JSON.stringify({ values: { id: 5, name: { nested: true } } }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('sql & ddl', () => {
  it('executes scripts with defaults applied', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) })
    expect(res.status).toBe(200)
    const results = z.array(StatementResultSchema).parse(await res.json())
    expect(results[0]?.kind).toBe('rows')
    expect(h.adapter.calls.at(-1)?.args).toEqual([
      { database: 'shop' },
      'SELECT 1',
      { maxRows: 1000, timeoutMs: 30_000, stopOnError: true, profile: false },
    ])
  })

  it('streams NDJSON: one result line per statement then done', async () => {
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) =>
        sql
          .split(';')
          .map((s, i) =>
            i === 1
              ? { kind: 'error' as const, sql: s, message: 'boom', code: 'QUERY_FAILED' as const }
              : { kind: 'affected' as const, sql: s, affectedRows: i, durationMs: 1 }
          ),
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql/stream', {
      method: 'POST',
      body: JSON.stringify({ sql: 'A;B;C', stopOnError: false }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => SqlStreamEventSchema.parse(JSON.parse(l)))
    expect(lines.map((l) => l.type)).toEqual(['result', 'result', 'result', 'done'])
    expect(lines[1]).toMatchObject({ type: 'result', index: 1, result: { kind: 'error', message: 'boom' } })
    expect(lines[3]).toEqual({ type: 'done', statements: 3, openTransaction: false })
  })

  it('streams a fatal line when the adapter throws', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    adapter.executeSql = async () => {
      throw new AdapterError('CONNECTION_FAILED', 'gone')
    }
    const res = await h.req('/api/databases/shop/sql/stream', {
      method: 'POST',
      body: JSON.stringify({ sql: 'SELECT 1' }),
    })
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => SqlStreamEventSchema.parse(JSON.parse(l)))
    expect(lines).toEqual([{ type: 'fatal', message: 'gone', code: 'CONNECTION_FAILED' }])
  })

  it('cancels the running script when the stream consumer aborts', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    adapter.executeSql = async (ns, sql, opts) => {
      adapter.calls.push({ method: 'executeSql', args: [ns, sql, opts] })
      const first = { kind: 'affected' as const, sql: 'A', affectedRows: 1, durationMs: 1 }
      await opts.onResult?.(first, 0)
      await gate // simulates a long second statement
      const second = { kind: 'affected' as const, sql: 'B', affectedRows: 1, durationMs: 1 }
      await opts.onResult?.(second, 1)
      return [first, second]
    }
    const queryId = crypto.randomUUID()
    const res = await h.req('/api/databases/shop/sql/stream', {
      method: 'POST',
      body: JSON.stringify({ sql: 'A;B', queryId }),
    })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('"index":0')
    await reader.cancel()
    expect(adapter.calls.at(-1)).toEqual({ method: 'cancelQuery', args: [queryId] })
    release()
    await new Promise((r) => setTimeout(r, 0))
    // Exactly one cancel per abort; a late result after cancel is dropped by the route's `closed` guard.
    expect(adapter.calls.filter((c) => c.method === 'cancelQuery')).toHaveLength(1)
  })

  it('applies backpressure: the next statement result waits until the consumer reads', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const emitted: number[] = []
    adapter.executeSql = async (_ns, _sql, opts) => {
      const r = { kind: 'affected' as const, sql: 'x', affectedRows: 1, durationMs: 1 }
      for (let i = 0; i < 3; i++) {
        await opts.onResult?.(r, i)
        emitted.push(i)
      }
      return [r, r, r]
    }
    const res = await h.req('/api/databases/shop/sql/stream', { method: 'POST', body: JSON.stringify({ sql: 'x' }) })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    await reader.read()
    await new Promise((r) => setTimeout(r, 20))
    // At most the first result (queued) plus one in flight: the rest is gated on our reads.
    expect(emitted.length).toBeLessThanOrEqual(2)
    while (!(await reader.read()).done) {
      // drain
    }
    expect(emitted).toEqual([0, 1, 2])
  })

  it('assigns a queryId to streamed scripts so an abort can always cancel them', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql/stream', { method: 'POST', body: JSON.stringify({ sql: 'X' }) })
    await res.text()
    const opts = h.adapter.calls.find((c) => c.method === 'executeSql')?.args[2] as { queryId?: string }
    expect(opts.queryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('passes queryId through and cancels by id', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const queryId = crypto.randomUUID()
    await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', queryId }) })
    expect(h.adapter.calls.at(-1)?.args[2]).toMatchObject({ queryId })
    const miss = await h.req('/api/databases/shop/sql/cancel', { method: 'POST', body: JSON.stringify({ queryId }) })
    expect(await miss.json()).toEqual({ cancelled: false })
    expect(
      (await h.req('/api/databases/shop/sql/cancel', { method: 'POST', body: JSON.stringify({ queryId: 'nope' }) }))
        .status
    ).toBe(400)
  })

  it('caps maxRows and rejects empty scripts', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(
      (await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'x', maxRows: 1e9 }) }))
        .status
    ).toBe(400)
    expect((await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: '' }) })).status).toBe(
      400
    )
  })

  it('fills copyTable columns, identity and serial columns for the preview (PostgreSQL)', async () => {
    const src = fakeTable('src', ['id', 'n', 'ab', 's'], [])
    for (const c of src.schema.columns) {
      if (c.name === 'id') c.extra = 'identity always'
      if (c.name === 'ab') c.extra = 'STORED GENERATED'
      if (c.name === 's') c.extra = 'serial'
    }
    const h = harness(new FakeAdapter({ dialect: 'postgres', databases: { shop: { tables: { src } } } }))
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'copyTable', table: 'src', newName: 'dst', withData: true } }),
    })
    expect(res.status).toBe(200)
    const sql = DdlPreviewResponseSchema.parse(await res.json()).sql.join('\n')
    expect(sql).toContain('INSERT INTO "public"."dst" ("id", "n", "s") OVERRIDING SYSTEM VALUE SELECT "id", "n", "s"')
    expect(sql).not.toMatch(/INSERT[^\n]*"ab"/)
    expect(sql).toContain('CREATE SEQUENCE "public"."dst_s_seq" OWNED BY "public"."dst"."s"')
    expect(sql).toContain(`pg_get_serial_sequence('"public"."dst"', 'id')`)
    expect(sql).toContain(`pg_get_serial_sequence('"public"."dst"', 's')`)
  })

  it('fills a database rename from the server, whatever table list the request carries', async () => {
    // The route, not only prepareDatabaseOp in isolation: moving that call after build() must fail here.
    const h = harness(
      new FakeAdapter({
        dialect: 'mysql',
        databases: {
          information_schema: { tables: {} },
          shop: { tables: { users: fakeTable('users', ['id'], []), posts: fakeTable('posts', ['id'], []) } },
        },
      })
    )
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/information_schema/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameDatabase', name: 'shop', newName: 'store', tables: ['users'] } }),
    })
    expect(res.status).toBe(200)
    const sql = DdlPreviewResponseSchema.parse(await res.json()).sql.join('\n')
    expect(sql).toContain('`shop`.`users` TO `store`.`users`')
    expect(sql).toContain('`shop`.`posts` TO `store`.`posts`')
    expect(h.adapter.calls.some((c) => c.method === 'executeSql')).toBe(false)
  })

  it('refuses a database rename through the route with a 400 and the reason', async () => {
    const view = fakeTable('active', ['id'], [])
    view.schema.kind = 'view'
    const h = harness(
      new FakeAdapter({
        dialect: 'mysql',
        databases: { information_schema: { tables: {} }, shop: { tables: { active: view } } },
      })
    )
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/information_schema/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameDatabase', name: 'shop', newName: 'store' } }),
    })
    expect(res.status).toBe(400)
    expect(ApiErrorSchema.parse(await res.json())).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('1 views'),
    })
  })

  it('searches one table per request and validates the term', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/search?q=ali')
    expect(res.status).toBe(200)
    expect(TableSearchResultSchema.parse(await res.json())).toMatchObject({ total: 1, count: 'exact' })
    expect((await h.req('/api/databases/shop/tables/users/search?q=')).status).toBe(400)
    expect((await h.req(`/api/databases/shop/tables/users/search?q=${'x'.repeat(SEARCH_TERM_MAX + 1)}`)).status).toBe(
      400
    )
    // PostgreSQL cannot hold NUL in text: refused before it reaches the server.
    expect((await h.req('/api/databases/shop/tables/users/search?q=a%00b')).status).toBe(400)
  })

  it('lists the foreign keys of a database for the designer', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/foreign-keys?schema=app')
    expect(res.status).toBe(200)
    RelationDefSchema.array().parse(await res.json())
    expect(h.adapter.calls.at(-1)).toMatchObject({
      method: 'listForeignKeys',
      args: [{ database: 'shop', schema: 'app' }],
    })
  })

  it('builds a query from structured choices and validates them', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const post = (body: unknown) => h.req('/api/databases/shop/query', { method: 'POST', body: JSON.stringify(body) })
    const res = await post({ tables: ['users'], where: [[{ table: 'users', column: 'name', op: 'eq', value: 'a' }]] })
    expect(res.status).toBe(200)
    expect(QueryBuilderResultSchema.parse(await res.json()).sql).toContain('users')
    expect(h.adapter.calls.at(-1)).toMatchObject({
      method: 'buildQuery',
      args: [{ database: 'shop' }, { tables: ['users'], columns: [] }],
    })
    expect((await post({ tables: [] })).status).toBe(400)
    // Only the listed operators: an unknown one is refused before any SQL is written.
    expect(
      (await post({ tables: ['users'], where: [[{ table: 'users', column: 'name', op: 'matches', value: '%' }]] }))
        .status
    ).toBe(400)
    expect((await post({ tables: ['missing'] })).status).toBe(404)
  })

  it('previews DDL without executing it', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'dropColumn', table: 'users', name: 'name' } }),
    })
    expect(res.status).toBe(200)
    expect(DdlPreviewResponseSchema.parse(await res.json())).toEqual({
      sql: ['ALTER TABLE `shop`.`users` DROP COLUMN `name`'],
    })
    expect(h.adapter.calls.some((c) => c.method === 'executeSql')).toBe(false)
  })

  it('rejects unknown DDL ops', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameEverything', table: 'users' } }),
    })
    expect(res.status).toBe(400)
  })
})

describe('export', () => {
  it('downloads a SQL dump of the whole database with a content-disposition', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/sql')
    expect(res.headers.get('content-disposition')).toContain('filename="shop.sql"')
    const body = await res.text()
    expect(body).toContain('-- Table: users')
    expect(body).toContain('INSERT INTO `users`')
  })

  it('aborts the transfer when the adapter fails mid-stream', async () => {
    const adapter = fixtureAdapter()
    const original = adapter.iterateRows.bind(adapter)
    adapter.iterateRows = async function* (ns, table, opts) {
      for await (const b of original(ns, table, opts)) {
        yield b
        throw new Error('connection lost')
      }
    }
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/export')
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
  })

  it('exports one table as CSV and rejects multi-table CSV', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const csv = await h.req('/api/databases/shop/export?format=csv&tables=users')
    expect(csv.status).toBe(200)
    expect(await csv.text()).toContain('id,name')
    expect((await h.req('/api/databases/shop/export?format=csv&tables=users,posts')).status).toBe(400)
    // Unknown tables are refused before the download starts (a JSON 404, not an aborted stream).
    expect((await h.req('/api/databases/shop/export?format=sql&tables=users,users2')).status).toBe(404)
    // A format that is not offered is refused, not guessed at.
    expect((await h.req('/api/databases/shop/export?format=xlsx')).status).toBe(400)
  })

  it('sends a file per format, packaged as asked, and refuses UPDATE for a table without a key', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ods = await h.req('/api/databases/shop/export?format=ods&tables=users')
    expect(ods.status).toBe(200)
    expect(ods.headers.get('content-type')).toBe('application/vnd.oasis.opendocument.spreadsheet')
    expect(ods.headers.get('content-disposition')).toContain('shop_users.ods')
    expect(new Uint8Array(await ods.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
    const gz = await h.req('/api/databases/shop/export?format=markdown&compress=gzip&filename=%40DATABASE%40-md')
    expect(gz.headers.get('content-type')).toBe('application/gzip')
    expect(gz.headers.get('content-disposition')).toContain('shop-md.md.gz')
    // A CSV per table lifts the one-table limit and comes as a zip.
    const zip = await h.req('/api/databases/shop/export?format=csv&filePerTable=1')
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toBe('application/zip')
    expect((await h.req('/api/databases/shop/export?format=latex&tables=users&charset=nope')).status).toBe(400)
  })
})

describe('server catalog', () => {
  it('returns collations, engines and plugins, and refuses a kind that is not one of them', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/server/catalog/engines')
    expect(res.status).toBe(200)
    expect(ServerCatalogSchema.parse(await res.json())).toEqual({ columns: ['name'], rows: [['fake engines']] })
    expect((await h.req('/api/server/catalog/users')).status).toBe(400)
  })

  it('returns the replication role, state and logs', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/server/replication')
    expect(res.status).toBe(200)
    expect(ReplicationInfoSchema.parse(await res.json())).toMatchObject({
      role: 'standalone',
      logs: [{ name: 'binlog.000001' }],
    })
  })

  it('previews a replication change with the password masked, and refuses one that is not valid', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const change = { op: 'changeSource', host: 'db1', user: 'repl', password: 'secret-pw', autoPosition: true }
    const res = await h.req('/api/server/replication/preview', { method: 'POST', body: JSON.stringify({ op: change }) })
    expect(res.status).toBe(200)
    const { sql } = (await res.json()) as { sql: string[] }
    expect(sql.join('\n')).toContain('****')
    expect(sql.join('\n')).not.toContain('secret-pw')
    const bad = await h.req('/api/server/replication/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { ...change, port: 0 } }),
    })
    expect(bad.status).toBe(400)
  })

  it('serves a diagnostic report by kind, and refuses a kind or a file it does not know', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/server/diagnostics/slowLog')
    expect(res.status).toBe(200)
    expect(DiagnosticReportSchema.parse(await res.json())).toMatchObject({ status: 'unsupported', rows: [] })
    expect((await h.req('/api/server/diagnostics/nothing')).status).toBe(400)
    expect((await h.req('/api/server/diagnostics/binlogEvents?file=')).status).toBe(400)
  })
})

describe('import', () => {
  const upload = (
    h: ReturnType<typeof harness>,
    fields: Record<string, string>,
    file: { name: string; body: string }
  ) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([file.body], file.name, { type: 'text/plain' }))
    // Browsers send Origin on same-origin form posts; hono/csrf requires it for multipart bodies.
    return h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
  }

  it('rejects files over IMPORT_MAX_BYTES and bodies over the route limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const tooBig = await upload(h, { format: 'sql' }, { name: 'big.sql', body: 'x'.repeat(IMPORT_MAX_BYTES + 1) })
    expect(tooBig.status).toBe(413)
    expect(ApiErrorSchema.parse(await tooBig.json()).code).toBe('PAYLOAD_TOO_LARGE')
    const overLimit = await upload(
      h,
      { format: 'sql' },
      { name: 'huge.sql', body: 'x'.repeat(IMPORT_MAX_BYTES + 2 * 1024 * 1024) }
    )
    expect(overLimit.status).toBe(413)
    expect(ApiErrorSchema.parse(await overLimit.json())).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
    })
  })

  it('decodes percent-encoded database and table names', async () => {
    const adapter = new FakeAdapter({
      databases: { 'we ird/db': { tables: { 'a?b': fakeTable('a?b', ['id'], [{ id: 1 }]) } } },
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req(
      `/api/databases/${encodeURIComponent('we ird/db')}/tables/${encodeURIComponent('a?b')}/rows`
    )
    expect(res.status).toBe(200)
    expect(BrowseResultSchema.parse(await res.json()).rows).toEqual([[1]])
  })

  it('imports a SQL file and reports per-statement results', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await upload(h, { format: 'sql' }, { name: 'dump.sql', body: 'INSERT INTO users VALUES (9); SELECT 1' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    // The run streams progress and then the result (NDJSON); a validation problem mid-run is a `fatal` event.
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((line) => ImportEventSchema.parse(JSON.parse(line)))
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { format: 'sql', succeeded: 1, failed: 0 } })
    const latin1 = await upload(h, { format: 'sql' }, { name: 'l1.sql', body: 'x' })
    expect(latin1.status).toBe(200)
    const bytes = new FormData()
    bytes.set('format', 'sql')
    bytes.set('file', new File([new Uint8Array([0x53, 0x45, 0x4c, 0xe9])], 'l1.sql'))
    const bad = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: bytes,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
    expect(bad.status).toBe(400)
    expect(ApiErrorSchema.parse(await bad.json())).toMatchObject({ code: 'VALIDATION', reason: 'INVALID_ENCODING' })
  })

  it('imports a CSV into a table and rejects bad headers with 400', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await upload(h, { format: 'csv', table: 'users' }, { name: 'u.csv', body: 'id,name\n7,Zed\n' })
    expect(res.status).toBe(200)
    const last = (text: string) => ImportEventSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? ''))
    expect(last(await res.text())).toMatchObject({
      type: 'result',
      result: { format: 'csv', inserted: 1, columns: ['id', 'name'] },
    })
    const rows = BrowseResultSchema.parse(await (await h.req('/api/databases/shop/tables/users/rows')).json())
    expect(rows.rows.some((r) => r[1] === 'Zed')).toBe(true)
    const bad = await upload(h, { format: 'csv', table: 'users' }, { name: 'u.csv', body: 'nope\n1\n' })
    expect(bad.status).toBe(200)
    expect(last(await bad.text())).toMatchObject({
      type: 'fatal',
      error: { code: 'VALIDATION', reason: 'CSV_UNKNOWN_COLUMNS' },
    })
  })

  it('rejects cross-site form posts (CSRF) with 403', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const fd = new FormData()
    fd.set('format', 'sql')
    fd.set('file', new File(['SELECT 1'], 'x.sql'))
    const res = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('requires a file and a valid format', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const fd = new FormData()
    fd.set('format', 'sql')
    const noFile = await h.app.request('/api/databases/shop/import', {
      method: 'POST',
      body: fd,
      headers: { cookie: h.cookie(), origin: 'http://localhost' },
    })
    expect(noFile.status).toBe(400)
    expect((await upload(h, { format: 'xml' }, { name: 'x', body: 'x' })).status).toBe(400)
  })
})

describe('users', () => {
  const withUsers = () =>
    fixtureAdapter({
      // Real drivers return affected-row results for account statements (never the SQL text).
      onSql: (_ns, sql) => [{ kind: 'affected', sql, affectedRows: 0, durationMs: 1 }],
      users: [
        { name: 'root', host: 'localhost', canLogin: true, attributes: [] },
        { name: 'app', host: '%', canLogin: false, attributes: ['LOCKED'] },
      ],
    })

  it('lists users and shows grants', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const users = await (await h.req('/api/users')).json()
    expect(users).toHaveLength(2)
    const grants = await (await h.req('/api/users/grants?name=app&host=%25')).json()
    expect(grants).toEqual({ statements: ["GRANT USAGE ON *.* TO 'app'@'%'"] })
    expect((await h.req('/api/users/grants?name=ghost')).status).toBe(404)
    await h.req('/api/users/grants?name=root&database=shop&schema=app')
    expect(h.adapter.calls.at(-1)).toEqual({
      method: 'showGrants',
      args: [{ name: 'root' }, { database: 'shop', schema: 'app' }],
    })
  })

  it('previews masked SQL and executes the real statements without echoing the password', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const op = {
      op: 'createUser',
      user: { name: 'new', host: '%' },
      password: 'hunter2',
      attributes: { createdb: true },
    }
    const preview = (await (
      await h.req('/api/users/preview', { method: 'POST', body: JSON.stringify({ op }) })
    ).json()) as { sql: string[] }
    expect(preview.sql[0]).toBe("CREATE USER 'new'@'%' IDENTIFIED BY '****'")
    expect(JSON.stringify(preview)).not.toContain('hunter2')
    const res = await h.req('/api/users/execute', { method: 'POST', body: JSON.stringify({ op }) })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('hunter2')
    // The response says outright whether a failure undid the statements that had succeeded (PostgreSQL wraps
    // a multi-statement account operation in one transaction); MySQL commits each statement as it runs.
    expect(JSON.parse(body)).toMatchObject({ rolledBack: false, results: [{ kind: 'affected' }] })
    const executed = h.adapter.calls.filter((c) => c.method === 'executeSql')
    expect(executed).toHaveLength(1)
    expect(executed[0]?.args[1]).toBe(
      "CREATE USER 'new'@'%' IDENTIFIED BY 'hunter2';\nGRANT CREATE ON *.* TO 'new'@'%'"
    )
    expect(executed[0]?.args[0]).toEqual({ database: 'information_schema' })
  })

  it('scrubs the password from error messages that quote the failing SQL', async () => {
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) => [
        {
          kind: 'error',
          sql,
          message: `You have an error in your SQL syntax near 'IDENTIFIED BY 'hunter2'' at line 1`,
          code: 'QUERY_FAILED',
        },
      ],
      users: [],
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/users/execute', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'setPassword', user: { name: 'x', host: '%' }, password: 'hunter2' } }),
    })
    const body = await res.text()
    expect(body).not.toContain('hunter2')
    expect(body).toContain('****')
  })

  it('refuses a column grant the servers could not run, on preview and on execute alike', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    const send = (path: string, op: unknown) =>
      h.req(`/api/users/${path}`, { method: 'POST', body: JSON.stringify({ op }) })
    const base = { user: { name: 'r', host: '%' }, database: 'shop', table: 'orders' }
    // The rule lives in a refinement on the request schema, so both routes have to carry it: previewing SQL
    // that execute would then reject is the one failure mode worth pinning down.
    for (const path of ['preview', 'execute']) {
      // DELETE has no column form on either server.
      expect(
        (await send(path, { op: 'grantPrivileges', ...base, privileges: ['DELETE'], columns: ['id'] })).status
      ).toBe(400)
      // Columns without a table name nothing.
      const { table: _table, ...noTable } = base
      expect(
        (await send(path, { op: 'grantPrivileges', ...noTable, privileges: ['SELECT'], columns: ['id'] })).status
      ).toBe(400)
      // The valid form goes through.
      expect(
        (await send(path, { op: 'grantPrivileges', ...base, privileges: ['SELECT'], columns: ['id'] })).status
      ).toBe(200)
    }
    expect(h.adapter.calls.filter((c) => c.method === 'executeSql').map((c) => c.args[1])).toEqual([
      "GRANT SELECT (`id`) ON `shop`.`orders` TO 'r'@'%'",
    ])
  })

  it('validates user ops', async () => {
    const h = harness(withUsers())
    stores.push(h.store)
    await h.login()
    expect(
      (await h.req('/api/users/preview', { method: 'POST', body: JSON.stringify({ op: { op: 'nuke' } }) })).status
    ).toBe(400)
    expect((await h.req('/api/users')).status).toBe(200)
    expect((await h.app.request('/api/users')).status).toBe(401)
  })
})

describe('server', () => {
  const withProcesses = () =>
    fixtureAdapter({
      processes: [
        {
          id: '7',
          user: 'root',
          host: 'localhost',
          database: 'shop',
          state: 'Query',
          timeSec: 3,
          query: 'SELECT 1',
          self: false,
        },
        {
          id: '8',
          user: 'app',
          host: '10.0.0.1',
          database: null,
          state: 'Sleep',
          timeSec: 120,
          query: null,
          self: true,
        },
      ],
    })

  it('exposes info, variables, status and processes', async () => {
    const h = harness(withProcesses())
    stores.push(h.store)
    await h.login()
    expect(ServerInfoSchema.parse(await (await h.req('/api/server/info')).json()).version).toBe('0.0.0-fake')
    expect(
      z
        .array(KeyValueSchema)
        .parse(await (await h.req('/api/server/variables')).json())
        .some((v) => v.name === 'max_connections')
    ).toBe(true)
    expect(z.array(KeyValueSchema).parse(await (await h.req('/api/server/status')).json())).toHaveLength(1)
    expect(z.array(ProcessInfoSchema).parse(await (await h.req('/api/server/processes')).json())).toHaveLength(2)
  })

  it('kills a process by numeric id only', async () => {
    const h = harness(withProcesses())
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/server/processes/8/kill', { method: 'POST' })).status).toBe(200)
    expect(
      z
        .array(ProcessInfoSchema)
        .parse(await (await h.req('/api/server/processes')).json())
        .map((p) => p.id)
    ).toEqual(['7'])
    expect((await h.req('/api/server/processes/8/kill', { method: 'POST' })).status).toBe(404)
    expect((await h.req('/api/server/processes/abc/kill', { method: 'POST' })).status).toBe(400)
    expect(
      (await h.app.request('/api/server/processes/7/kill', { method: 'POST', headers: { origin: 'http://localhost' } }))
        .status
    ).toBe(401)
  })
})

describe('errors', () => {
  it('normalises unexpected errors as 500 INTERNAL without leaking stack traces', async () => {
    const adapter = fixtureAdapter()
    adapter.listDatabases = async () => {
      throw new Error('boom')
    }
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases')
    expect(res.status).toBe(500)
    const err = ApiErrorSchema.parse(await res.json())
    expect(err.code).toBe('INTERNAL')
    expect(err.message).toBe('Internal error')
  })
})

describe('second factor', () => {
  /** The same persistent-store harness, with a clock the test can hold still. */
  function totpHarness(
    options: { require2fa?: boolean; maxPerIdentity?: number; manageAccounts?: boolean; passkeys?: boolean } = {}
  ) {
    let now = 1_700_000_000_000
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () =>
        fixtureAdapter({
          users: ['root', 'alice'].map((name) => ({ name, host: '%', canLogin: true, attributes: [] })),
          manageAccounts: options.manageAccounts ?? true,
        }),
      sweepIntervalMs: 0,
      ...(options.maxPerIdentity === undefined ? {} : { maxPerIdentity: options.maxPerIdentity }),
    })
    const app = createApp(
      {
        ...testConfig(),
        require2fa: options.require2fa ?? false,
        // The origin and challenge the recorded passkey answers were made for (see passkey.fixture.json).
        passkey: options.passkeys ? { origin: PASSKEY_FIXTURE.origin, rpId: PASSKEY_FIXTURE.rpId } : null,
      },
      { store, now: () => now, challenge: () => new Uint8Array(32).fill(9) }
    )
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (body: Record<string, unknown> = LOGIN) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body) })
      const set = res.headers.get('set-cookie')?.split(';')[0]
      if (set) cookie = set
      return res
    }
    return { store, req, login, at: () => now, tick: (ms: number) => (now += ms) }
  }

  /** Enrols and returns the secret plus the recovery codes shown once. */
  async function enrol(h: ReturnType<typeof totpHarness>) {
    const setup = SecondFactorSetupSchema.parse(
      await (await h.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()
    )
    const confirmed = await h.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
    })
    expect(confirmed.status).toBe(201)
    return setup
  }

  it('asks for a code at the next login, and refuses one that was already used', async () => {
    const h = totpHarness()
    try {
      await h.login()
      const setup = await enrol(h)
      expect(SecondFactorStatusSchema.parse(await (await h.req('/api/second-factor')).json())).toEqual({
        state: 'enrolled',
        recoveryCodesLeft: 10,
        totp: true,
        passkeys: [],
        passkeysAvailable: false,
      })

      // The password alone is no longer enough, and a wrong code is a different answer from a missing one.
      expect(ApiErrorSchema.parse(await (await h.login()).json()).code).toBe('SECOND_FACTOR_REQUIRED')
      expect(ApiErrorSchema.parse(await (await h.login({ ...LOGIN, code: '000000' })).json()).code).toBe(
        'SECOND_FACTOR_INVALID'
      )

      // A fresh step: the code that confirmed the enrolment is spent, as any used code is.
      h.tick(30_000)
      const code = codeFor(setup.secret, stepAt(h.at()))
      expect((await h.login({ ...LOGIN, code })).status).toBe(201)
      // The same code inside its own 30 seconds: refused, so one seen over a shoulder is of no use.
      expect(ApiErrorSchema.parse(await (await h.login({ ...LOGIN, code })).json()).code).toBe('SECOND_FACTOR_INVALID')
      // The next step's code works.
      h.tick(30_000)
      expect((await h.login({ ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) })).status).toBe(201)
    } finally {
      await h.store.closeAll()
    }
  })

  it('takes a recovery code once, and lets the factor be removed with a current code', async () => {
    const h = totpHarness()
    try {
      await h.login()
      const setup = await enrol(h)
      const recovery = setup.recoveryCodes[0] ?? ''
      h.tick(30_000)

      expect((await h.login({ ...LOGIN, code: recovery })).status).toBe(201)
      expect(SecondFactorStatusSchema.parse(await (await h.req('/api/second-factor')).json())).toMatchObject({
        recoveryCodesLeft: 9,
      })
      // Used up: the same one does not work twice.
      expect(ApiErrorSchema.parse(await (await h.login({ ...LOGIN, code: recovery })).json()).code).toBe(
        'SECOND_FACTOR_INVALID'
      )

      // Removing it takes a code from the app, not a recovery code.
      h.tick(30_000)
      const stale = await h.req('/api/second-factor', {
        method: 'DELETE',
        body: JSON.stringify({ code: setup.recoveryCodes[1] ?? '' }),
      })
      expect(stale.status).toBe(401)
      const removed = await h.req('/api/second-factor', {
        method: 'DELETE',
        body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
      })
      expect(removed.status).toBe(200)
      expect((await h.login()).status).toBe(201)
    } finally {
      await h.store.closeAll()
    }
  })

  it('lets an account that must enrol do nothing else until it has', async () => {
    const h = totpHarness({ require2fa: true })
    try {
      const state = SessionStateSchema.parse(await (await h.login()).json())
      expect(state.secondFactor).toBe('enrollment_required')
      // Everything but enrolment is refused while it has not.
      expect((await h.req('/api/databases')).status).toBe(401)
      const setup = await enrol(h)
      expect((await h.req('/api/databases')).status).toBe(200)
      // And the next login needs the code, as for anyone else.
      h.tick(30_000)
      expect((await h.login()).status).toBe(401)
      expect((await h.login({ ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) })).status).toBe(201)
    } finally {
      await h.store.closeAll()
    }
  })

  it('needs the current code before a new one can replace it', async () => {
    const h = totpHarness()
    try {
      await h.login()
      const setup = await enrol(h)
      // A session someone else got hold of must not be able to swap the factor for one of its own: that would
      // be a removal, and removing takes a code.
      expect((await h.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).status).toBe(401)
      expect(
        (await h.req('/api/second-factor/begin', { method: 'POST', body: JSON.stringify({ code: '000000' }) })).status
      ).toBe(401)
      h.tick(30_000)
      const again = await h.req('/api/second-factor/begin', {
        method: 'POST',
        body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
      })
      expect(again.status).toBe(200)
      expect(SecondFactorSetupSchema.parse(await again.json()).secret).not.toBe(setup.secret)
    } finally {
      await h.store.closeAll()
    }
  })

  it('does not close the account’s other sessions when the code is wrong', async () => {
    // One session per account: a login that is refused would otherwise have taken the place of the live one.
    const h = totpHarness({ maxPerIdentity: 1 })
    try {
      await h.login()
      const setup = await enrol(h)
      h.tick(30_000)
      expect((await h.login()).status).toBe(401)
      expect((await h.login({ ...LOGIN, code: '000000' })).status).toBe(401)
      // The cookie is still the one from the first login: that session is expected to have survived.
      expect((await h.req('/api/second-factor')).status).toBe(200)
      expect(h.store.size).toBe(1)
      // And a login that is accepted does take its place, as it did before.
      expect((await h.login({ ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) })).status).toBe(201)
      expect(h.store.size).toBe(1)
    } finally {
      await h.store.closeAll()
    }
  })

  const ALICE = { ...LOGIN, user: 'alice' }

  describe('passkeys', () => {
    const assertion = (n: number) => PASSKEY_FIXTURE.assertions[n] as Record<string, unknown>
    /** Enrols the recorded passkey for the session's account; returns the recovery codes shown. */
    async function addPasskey(h: ReturnType<typeof totpHarness>) {
      const begun = await h.req('/api/second-factor/passkeys/begin', { method: 'POST', body: '{}' })
      expect(begun.status).toBe(200)
      const { recoveryCodes } = PasskeyRegistrationSchema.parse(await begun.json())
      // As @simplewebauthn/browser sends it: with the new key's COSE algorithm as a number (-7, ES256).
      const registration = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
      const response = { ...registration, response: { ...registration.response, publicKeyAlgorithm: -7 } }
      const done = await h.req('/api/second-factor/passkeys/confirm', {
        method: 'POST',
        body: JSON.stringify({ response }),
      })
      expect(done.status).toBe(201)
      return recoveryCodes
    }
    /** A refused login's passkey challenge ticket (the password was right; the factor is asked for). */
    async function loginTicket(h: ReturnType<typeof totpHarness>, as = LOGIN) {
      const res = await h.login(as)
      expect(res.status).toBe(401)
      const body = ApiErrorSchema.parse(await res.json())
      expect(body.code).toBe('SECOND_FACTOR_REQUIRED')
      return body.passkey?.ticket ?? ''
    }
    const withPasskey = (ticket: string, n: number, as = LOGIN) => ({
      ...as,
      passkey: { ticket, response: assertion(n) },
    })

    it('enrols a passkey, signs in with it, and takes each answer once', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        await h.login()
        // The first factor comes with recovery codes, as it does with an app.
        expect(await addPasskey(h)).toHaveLength(10)
        expect(SecondFactorStatusSchema.parse(await (await h.req('/api/second-factor')).json())).toMatchObject({
          state: 'enrolled',
          totp: false,
          passkeys: [{ id: PASSKEY_FIXTURE.assertions[0]?.id }],
          passkeysAvailable: true,
        })
        await h.req('/api/session', { method: 'DELETE' })

        const ticket = await loginTicket(h)
        expect(ticket).not.toBe('')
        expect((await h.login(withPasskey(ticket, 0))).status).toBe(201)
        // The ticket is spent, and so is that answer: its counter no longer moves the stored one forward.
        expect((await h.login(withPasskey(ticket, 1))).status).toBe(401)
        expect((await h.login(withPasskey(await loginTicket(h), 0))).status).toBe(401)
        expect((await h.login(withPasskey(await loginTicket(h), 1))).status).toBe(201)
      } finally {
        await h.store.closeAll()
      }
    })

    it('refuses a tampered answer, and a challenge issued for something else', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        await h.login()
        await addPasskey(h)
        // A challenge this session was given as proof is not a login challenge.
        const proofTicket = PasskeyChallengeSchema.parse(
          await (await h.req('/api/second-factor/passkeys/challenge', { method: 'POST' })).json()
        ).ticket
        await h.req('/api/session', { method: 'DELETE' })
        expect((await h.login(withPasskey(proofTicket, 0))).status).toBe(401)
        // One flipped signature byte.
        const good = assertion(0) as { response: Record<string, string> }
        const signature = Buffer.from(good.response.signature ?? '', 'base64url')
        signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 1
        const tampered = { ...good, response: { ...good.response, signature: signature.toString('base64url') } }
        const bad = await h.login({ ...LOGIN, passkey: { ticket: await loginTicket(h), response: tampered } })
        expect(ApiErrorSchema.parse(await bad.json()).code).toBe('SECOND_FACTOR_INVALID')
        // Still good afterwards: nothing was spent by the refusals.
        expect((await h.login(withPasskey(await loginTicket(h), 0))).status).toBe(201)
      } finally {
        await h.store.closeAll()
      }
    })

    it('asks for proof before changing the factor, and a passkey is proof', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        await h.login()
        await addPasskey(h)
        // Adding an app over it without proof is refused; with a passkey's answer it goes ahead, keeping the codes.
        expect((await h.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).status).toBe(401)
        const proof = async (n: number) => {
          const { ticket } = PasskeyChallengeSchema.parse(
            await (await h.req('/api/second-factor/passkeys/challenge', { method: 'POST' })).json()
          )
          return { passkey: { ticket, response: assertion(n) } }
        }
        const begun = await h.req('/api/second-factor/begin', { method: 'POST', body: JSON.stringify(await proof(0)) })
        expect(begun.status).toBe(200)
        expect(SecondFactorSetupSchema.parse(await begun.json()).recoveryCodes).toEqual([])
        // Removing the passkey (the only method, as the app was not confirmed) turns the factor off.
        const id = String(PASSKEY_FIXTURE.assertions[0]?.id)
        expect(
          (
            await h.req(`/api/second-factor/passkeys/${id}`, {
              method: 'DELETE',
              body: JSON.stringify({ code: '000000' }),
            })
          ).status
        ).toBe(401)
        const removed = await h.req(`/api/second-factor/passkeys/${id}`, {
          method: 'DELETE',
          body: JSON.stringify(await proof(1)),
        })
        expect(SecondFactorStatusSchema.parse(await removed.json())).toMatchObject({ state: 'none', passkeys: [] })
      } finally {
        await h.store.closeAll()
      }
    })

    it('does not write over a method added at the same moment from another tab', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        await h.login()
        const setup = await enrol(h)
        const store = h.store.secondFactor
        if (!store) throw new Error('no store')
        const config = { ...LOGIN, dialect: 'mysql' as const }
        const passkey = (id: string) => ({ id, publicKey: 'AA', counter: 0, at: h.at() })
        const enrolled = await store.get(config)
        if (!enrolled) throw new Error('not enrolled')
        await store.set(config, { ...enrolled, passkeys: [passkey('first')] })
        // Just before the app is taken off, another tab adds a passkey (a write that checks out on its own).
        const set = store.set.bind(store)
        let raced = false
        store.set = async (cfg, factor) => {
          if (!raced && factor.secret === undefined) {
            raced = true
            const now = await store.get(cfg)
            if (now) await set(cfg, { ...now, passkeys: [...(now.passkeys ?? []), passkey('other-tab')] })
          }
          return set(cfg, factor)
        }
        h.tick(30_000)
        const res = await h.req('/api/second-factor/totp', {
          method: 'DELETE',
          body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
        })
        expect(res.status).toBe(200)
        expect(raced).toBe(true)
        const after = await store.get(config)
        expect(after?.secret).toBeUndefined()
        expect(after?.passkeys?.map((p) => p.id)).toEqual(['first', 'other-tab'])
      } finally {
        await h.store.closeAll()
      }
    })

    it('does not remove the factor when a method arrived while its last one was being taken off', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        await h.login()
        const setup = await enrol(h)
        const store = h.store.secondFactor
        if (!store) throw new Error('no store')
        const config = { ...LOGIN, dialect: 'mysql' as const }
        // The app is the only method; just before it goes, another tab adds a passkey.
        const clear = store.clear.bind(store)
        let raced = false
        store.clear = async (cfg, version) => {
          if (!raced) {
            raced = true
            const now = await store.get(cfg)
            if (now) {
              await store.set(cfg, { ...now, passkeys: [{ id: 'other-tab', publicKey: 'AA', counter: 0, at: h.at() }] })
            }
          }
          return clear(cfg, version)
        }
        h.tick(30_000)
        const res = await h.req('/api/second-factor/totp', {
          method: 'DELETE',
          body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
        })
        expect(res.status).toBe(200)
        expect(raced).toBe(true)
        // What is left is the passkey: the account is still protected, by the method that just arrived.
        const after = await store.get(config)
        expect(after?.secret).toBeUndefined()
        expect(after?.passkeys?.map((p) => p.id)).toEqual(['other-tab'])
        expect(SecondFactorStatusSchema.parse(await res.json()).state).toBe('enrolled')
      } finally {
        await h.store.closeAll()
      }
    })

    it('keeps one challenge per account: asking again replaces the one before', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        await h.login()
        await addPasskey(h)
        await h.req('/api/session', { method: 'DELETE' })
        const first = await loginTicket(h)
        const second = await loginTicket(h)
        expect(second).not.toBe(first)
        expect((await h.login(withPasskey(first, 0))).status).toBe(401)
        expect((await h.login(withPasskey(await loginTicket(h), 0))).status).toBe(201)
      } finally {
        await h.store.closeAll()
      }
    })

    it('is not offered where no origin is configured', async () => {
      const h = totpHarness()
      try {
        await h.login()
        expect(SecondFactorStatusSchema.parse(await (await h.req('/api/second-factor')).json()).passkeysAvailable).toBe(
          false
        )
        const res = await h.req('/api/second-factor/passkeys/begin', { method: 'POST', body: '{}' })
        expect(res.status).toBe(400)
        expect(ApiErrorSchema.parse(await res.json()).code).toBe('UNSUPPORTED')
      } finally {
        await h.store.closeAll()
      }
    })
  })

  it('lets an operator reset another account that lost its device, and nothing more', async () => {
    const h = totpHarness()
    try {
      await h.login(ALICE)
      await enrol(h)
      await h.req('/api/session', { method: 'DELETE' })
      h.tick(30_000)

      await h.login()
      const listed = AccountSecondFactorsSchema.parse(await (await h.req('/api/second-factor/accounts')).json())
      expect(listed.accounts).toEqual(['alice'])
      const reset = await h.req('/api/second-factor/accounts/reset', {
        method: 'POST',
        body: JSON.stringify({ user: 'alice' }),
      })
      expect(reset.status).toBe(200)
      expect(AccountSecondFactorsSchema.parse(await reset.json()).accounts).toEqual([])
      // Gone for good: a second reset finds nothing, and alice signs in with her password alone again.
      expect(
        (await h.req('/api/second-factor/accounts/reset', { method: 'POST', body: JSON.stringify({ user: 'alice' }) }))
          .status
      ).toBe(404)
      await h.req('/api/session', { method: 'DELETE' })
      expect((await h.login(ALICE)).status).toBe(201)
    } finally {
      await h.store.closeAll()
    }
  })

  it('does not reset for an account the database would not let alter that one, nor its own', async () => {
    const h = totpHarness({ manageAccounts: false })
    try {
      await h.login(ALICE)
      await enrol(h)
      await h.req('/api/session', { method: 'DELETE' })
      h.tick(30_000)
      await h.login()
      // Not even listed: who has a second factor is not shown to those who could not act on it.
      expect(AccountSecondFactorsSchema.parse(await (await h.req('/api/second-factor/accounts')).json())).toEqual({
        accounts: [],
      })
      const refused = await h.req('/api/second-factor/accounts/reset', {
        method: 'POST',
        body: JSON.stringify({ user: 'alice' }),
      })
      expect(refused.status).toBe(403)
      expect((await h.login(ALICE)).status).toBe(401)
    } finally {
      await h.store.closeAll()
    }
    // Its own, even with the authority: that removal asks for a code, and a stolen session must not skip it.
    const own = totpHarness()
    try {
      await own.login()
      await enrol(own)
      const res = await own.req('/api/second-factor/accounts/reset', {
        method: 'POST',
        body: JSON.stringify({ user: 'root' }),
      })
      expect(res.status).toBe(403)
      expect(AccountSecondFactorsSchema.parse(await (await own.req('/api/second-factor/accounts')).json())).toEqual({
        accounts: [],
      })
      expect(SecondFactorStatusSchema.parse(await (await own.req('/api/second-factor')).json()).state).toBe('enrolled')
    } finally {
      await own.store.closeAll()
    }
  })

  it('refuses enrolment where the store cannot keep it, and says so before it is offered', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/second-factor/begin', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('UNSUPPORTED')
    // Reported as a state of its own, so the screen can leave the tab out instead of offering what would fail.
    expect(SecondFactorStatusSchema.parse(await (await h.req('/api/second-factor')).json())).toEqual({
      state: 'unsupported',
      recoveryCodesLeft: 0,
      totp: false,
      passkeys: [],
      passkeysAvailable: false,
    })
    expect(SessionStateSchema.parse(await (await h.req('/api/session')).json()).secondFactor).toBe('unsupported')
  })
})

describe('saved queries', () => {
  /** Same harness, but on the persistent store — the only one that can keep bookmarks. */
  function persistentHarness() {
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => fixtureAdapter(),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (body: Record<string, unknown> = LOGIN) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
      return res
    }
    const save = (name: string, sql: string) =>
      req('/api/saved-queries', { method: 'POST', body: JSON.stringify({ name, sql }) })
    return { store, req, login, save }
  }

  it('tells the client the list lives on the server and round-trips it', async () => {
    const h = persistentHarness()
    try {
      const state = SessionStateSchema.parse(await (await h.login()).json())
      expect(state.savedQueries).toBe('server')

      const saved = z.array(SavedQuerySchema).parse(await (await h.save('daily', 'SELECT 1')).json())
      expect(saved).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }])
      expect(await (await h.req('/api/saved-queries')).json()).toEqual(saved)

      const left = await (await h.req(`/api/saved-queries/${saved[0]?.id}`, { method: 'DELETE' })).json()
      expect(left).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps one account out of another account’s list', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const mine = z.array(SavedQuerySchema).parse(await (await h.save('mine', 'SELECT 1')).json())
      // A second login as a different user gets a session of its own, and sees none of it.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/saved-queries')).json()).toEqual([])
      // Nor can it delete a row it cannot see.
      expect(await (await h.req(`/api/saved-queries/${mine[0]?.id}`, { method: 'DELETE' })).json()).toEqual([])
      await h.login()
      expect(await (await h.req('/api/saved-queries')).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('needs a session, and rejects an empty name or statement', async () => {
    const h = persistentHarness()
    try {
      expect((await h.save('daily', 'SELECT 1')).status).toBe(401)
      await h.login()
      expect((await h.save('', 'SELECT 1')).status).toBe(400)
      expect((await h.save('daily', '')).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('caps the statement length, because this list is kept on disk', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      expect((await h.save('long', 'x'.repeat(SAVED_QUERY_MAX_SQL))).status).toBe(200)
      // Without a cap, the 200-row allowance alone would let one account write 200 MB into the session file.
      expect((await h.save('longer', 'x'.repeat(SAVED_QUERY_MAX_SQL + 1))).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps query-builder setups per database and name, and refuses one the builder would refuse', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const setup = (database: string, tables: string[]) => ({
        name: 'mine',
        database,
        request: { tables, columns: [], where: [] },
      })
      const post = (body: unknown) => h.req('/api/query-templates', { method: 'POST', body: JSON.stringify(body) })
      await post(setup('shop', ['users']))
      // The same name in another database is another setup; in the same one it replaces.
      await post(setup('other', ['t']))
      const saved = z.array(QueryTemplateSchema).parse(await (await post(setup('shop', ['users', 'posts']))).json())
      expect(saved.map((x) => [x.database, x.request.tables])).toEqual(
        expect.arrayContaining([
          ['shop', ['users', 'posts']],
          ['other', ['t']],
        ])
      )
      expect(saved).toHaveLength(2)
      expect((await post(setup('shop', []))).status).toBe(400)
      const id = saved.find((x) => x.database === 'other')?.id ?? ''
      expect(await (await h.req(`/api/query-templates/${id}`, { method: 'DELETE' })).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps Designer pages per database and name, and refuses positions that are not numbers', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const page = (database: string, x: number) => ({ name: 'overview', database, positions: { users: { x, y: 0 } } })
      const post = (body: unknown) => h.req('/api/designer-pages', { method: 'POST', body: JSON.stringify(body) })
      await post(page('shop', 1))
      await post(page('other', 2))
      const saved = z.array(DesignerPageSchema).parse(await (await post(page('shop', 3))).json())
      expect(saved.map((x) => [x.database, x.positions.users?.x, x.allColumns])).toEqual(
        expect.arrayContaining([
          ['shop', 3, false],
          ['other', 2, false],
        ])
      )
      expect(saved).toHaveLength(2)
      expect((await post({ ...page('shop', 1), positions: { users: { x: 'left', y: 0 } } })).status).toBe(400)
      const id = saved.find((x) => x.database === 'other')?.id ?? ''
      expect(await (await h.req(`/api/designer-pages/${id}`, { method: 'DELETE' })).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps export templates as their own list beside the bookmarks', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const body = {
        name: 'nightly',
        database: 'shop',
        tables: ['users'],
        options: {
          format: 'csv',
          structure: false,
          data: true,
          dropTable: true,
          bom: true,
          csvSafe: true,
          routines: false,
          stripDefiner: false,
        },
      }
      const saved = z
        .array(ExportTemplateSchema)
        .parse(await (await h.req('/api/export-templates', { method: 'POST', body: JSON.stringify(body) })).json())
      expect(saved).toMatchObject([{ name: 'nightly', database: 'shop', tables: ['users'] }])
      expect(saved[0]?.options.format).toBe('csv')
      // The same name in the other list is a different item, and neither list shows the other's.
      await h.save('nightly', 'SELECT 1')
      expect(await (await h.req('/api/export-templates')).json()).toHaveLength(1)
      expect(z.array(SavedQuerySchema).parse(await (await h.req('/api/saved-queries')).json())).toMatchObject([
        { name: 'nightly', sql: 'SELECT 1' },
      ])
      // The same name in another database is a second template, not a replacement of the first.
      const both = z.array(ExportTemplateSchema).parse(
        await (
          await h.req('/api/export-templates', {
            method: 'POST',
            body: JSON.stringify({ ...body, database: 'blog' }),
          })
        ).json()
      )
      expect(both.map((x) => x.database).sort()).toEqual(['blog', 'shop'])
      // Deleting by an id of the other kind removes nothing.
      const bookmarks = z.array(SavedQuerySchema).parse(await (await h.req('/api/saved-queries')).json())
      expect(
        await (await h.req(`/api/export-templates/${bookmarks[0]?.id}`, { method: 'DELETE' })).json()
      ).toHaveLength(2)
      expect(await (await h.req('/api/saved-queries')).json()).toHaveLength(1)
      await h.req(`/api/export-templates/${both.find((x) => x.database === 'blog')?.id}`, { method: 'DELETE' })

      // A template of another database is refused before it is stored; deleting is by id, as bookmarks are.
      expect(
        (await h.req('/api/export-templates', { method: 'POST', body: JSON.stringify({ ...body, database: '' }) }))
          .status
      ).toBe(400)
      expect(await (await h.req(`/api/export-templates/${saved[0]?.id}`, { method: 'DELETE' })).json()).toEqual([])
      expect(await (await h.req('/api/saved-queries')).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('reads a template row written before the name was kept in its payload, and leaves it alone', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const config = ConnectRequestSchema.parse(LOGIN)
      // Older than the legacy row below, so an eviction would take one of these rather than the row being replaced.
      for (let i = 0; i < SAVED_QUERY_LIMIT - 1; i++) {
        await h.store.savedQueries.save(config, 'sql', `fill-${i}`, 'SELECT 1')
      }
      // The shape 0.3.0-dev wrote: the name was the row's key, the body held only the choices. The account is now
      // exactly at its cap, so replacing this row must not make room for itself by evicting anything.
      const body = { database: 'shop', tables: ['users'], options: { format: 'sql' } }
      await h.store.savedQueries.save(config, 'export', 'nightly', JSON.stringify(body))
      const listed = z.array(ExportTemplateSchema).parse(await (await h.req('/api/export-templates')).json())
      expect(listed).toMatchObject([{ name: 'nightly', database: 'shop', tables: ['users'] }])
      expect(await h.store.savedQueries.list(config, 'sql')).toHaveLength(SAVED_QUERY_LIMIT - 1)

      // A save that fails puts the row it was replacing back, rather than leaving the account with neither.
      const real = h.store.savedQueries.save.bind(h.store.savedQueries)
      let broken = true
      h.store.savedQueries.save = async (...args: Parameters<typeof real>) => {
        // The write of the new row fails; putting the old one back must still work, as it would on a real store.
        if (args[1] === 'export' && broken) {
          broken = false
          throw new Error('disk full')
        }
        return real(...args)
      }
      const failed = await h.req('/api/export-templates', {
        method: 'POST',
        body: JSON.stringify({ name: 'nightly', database: 'shop', tables: ['posts'], options: {} }),
      })
      expect(failed.status).toBe(500)
      h.store.savedQueries.save = real
      expect(z.array(ExportTemplateSchema).parse(await (await h.req('/api/export-templates')).json())).toMatchObject([
        { name: 'nightly', tables: ['users'] },
      ])

      // Saving that name again replaces it rather than leaving two rows showing the same name.
      const after = z.array(ExportTemplateSchema).parse(
        await (
          await h.req('/api/export-templates', {
            method: 'POST',
            body: JSON.stringify({ name: 'nightly', database: 'shop', tables: ['posts'], options: {} }),
          })
        ).json()
      )
      expect(after).toMatchObject([{ name: 'nightly', tables: ['posts'] }])
      expect(await (await h.req('/api/export-templates')).json()).toHaveLength(1)
      // The bookmarks that filled the account are all still there.
      expect(await h.store.savedQueries.list(config, 'sql')).toHaveLength(SAVED_QUERY_LIMIT - 1)
      await h.req(`/api/export-templates/${after[0]?.id}`, { method: 'DELETE' })

      // Reading it did not delete it: a row this version cannot fully interpret is not data to throw away.
      // The legacy row was read as a template before it was replaced, rather than being thrown away on sight.
      expect(listed[0]?.tables).toEqual(['users'])
    } finally {
      await h.store.closeAll()
    }
  })

  it('reports the browser mode, and refuses to save, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    const state = SessionStateSchema.parse(await (await h.login()).json())
    expect(state.savedQueries).toBe('browser')
    expect(await (await h.req('/api/saved-queries')).json()).toEqual([])
    const res = await h.req('/api/saved-queries', {
      method: 'POST',
      body: JSON.stringify({ name: 'daily', sql: 'SELECT 1' }),
    })
    expect(res.status).toBe(400)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('UNSUPPORTED')
    expect(await (await h.req('/api/export-templates')).json()).toEqual([])
    const template = await h.req('/api/export-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'nightly', database: 'shop', options: {} }),
    })
    expect(template.status).toBe(400)
    expect(ApiErrorSchema.parse(await template.json()).code).toBe('UNSUPPORTED')
  })
})

describe('preferences, central columns and column transformations', () => {
  function persistentHarness() {
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => fixtureAdapter(),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (body: Record<string, unknown> = LOGIN) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
      return res
    }
    const send = (path: string, method: string, body: unknown) => req(path, { method, body: JSON.stringify(body) })
    return { store, req, login, send }
  }

  it('keeps preferences with the account, and only the known fields', async () => {
    const h = persistentHarness()
    try {
      expect((await h.send('/api/preferences', 'PUT', { theme: 'dark' })).status).toBe(401)
      await h.login()
      expect(await (await h.req('/api/preferences')).json()).toEqual({})
      const put = await h.send('/api/preferences', 'PUT', { theme: 'dark', browseLimit: 25, extra: 'dropped' })
      expect(await put.json()).toEqual({ theme: 'dark', browseLimit: 25 })
      expect(await (await h.req('/api/preferences')).json()).toEqual({ theme: 'dark', browseLimit: 25 })
      expect((await h.send('/api/preferences', 'PUT', { browseLimit: 0 })).status).toBe(400)
      // Merged, not replaced: a second tab sending only what it changed keeps what the first one set.
      await h.send('/api/preferences', 'PUT', { consoleDocked: true })
      expect(await (await h.req('/api/preferences')).json()).toEqual({
        theme: 'dark',
        browseLimit: 25,
        consoleDocked: true,
      })
      // Another account has its own.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/preferences')).json()).toEqual({})
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps central columns per database, replacing one by name', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const column = { database: 'shop', name: 'created_at', dataType: 'datetime', nullable: false, default: null }
      await h.send('/api/central-columns', 'POST', column)
      await h.send('/api/central-columns', 'POST', { ...column, database: 'blog' })
      const replaced = z
        .array(CentralColumnSchema)
        .parse(await (await h.send('/api/central-columns', 'POST', { ...column, dataType: 'timestamp' })).json())
      expect(replaced.map((c) => [c.database, c.dataType]).sort()).toEqual([
        ['blog', 'datetime'],
        ['shop', 'timestamp'],
      ])
      const shop = replaced.find((c) => c.database === 'shop')
      // Another account can neither see nor delete it by id.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req(`/api/central-columns/${shop?.id}`, { method: 'DELETE' })).json()).toEqual([])
      await h.login()
      const left = await (await h.req(`/api/central-columns/${shop?.id}`, { method: 'DELETE' })).json()
      expect(left).toMatchObject([{ database: 'blog' }])
      expect((await h.send('/api/central-columns', 'POST', { ...column, name: '' })).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps one transformation per column, and refuses a link template that is not http(s)', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const target = { database: 'shop', table: 'items', column: 'url' }
      await h.send('/api/column-transforms', 'POST', { ...target, kind: 'link' })
      const set = z
        .array(ColumnTransformSchema)
        .parse(
          await (
            await h.send('/api/column-transforms', 'POST', { ...target, kind: 'link', template: 'https://x/{value}' })
          ).json()
        )
      expect(set).toMatchObject([{ kind: 'link', template: 'https://x/{value}' }])
      const refused = await h.send('/api/column-transforms', 'POST', {
        ...target,
        kind: 'link',
        template: 'javascript:alert({value})',
      })
      expect(refused.status).toBe(400)
      expect((await h.send('/api/column-transforms', 'POST', { ...target, kind: 'script' })).status).toBe(400)
      expect(await (await h.req(`/api/column-transforms/${set[0]?.id}`, { method: 'DELETE' })).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('reads as empty, and refuses to write, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/preferences')).json()).toEqual({})
    expect(await (await h.req('/api/central-columns')).json()).toEqual([])
    const put = await h.req('/api/preferences', { method: 'PUT', body: JSON.stringify({ theme: 'dark' }) })
    expect(put.status).toBe(400)
    expect(await put.json()).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('user groups', () => {
  function sharedHarness() {
    let manage = true
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => fixtureAdapter({ manageAccounts: manage }),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    /** Signs in as `user`; `canManage` decides what the new session's canManageAccount answers. */
    const login = async (user: string, canManage = true) => {
      manage = canManage
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify({ ...LOGIN, user }) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
      return res
    }
    const save = (body: unknown) => req('/api/user-groups', { method: 'POST', body: JSON.stringify(body) })
    return { store, req, login, save }
  }

  it('hides what a group says from its members, and only from them', async () => {
    const h = sharedHarness()
    try {
      await h.login('root')
      const saved = await h.save({ name: 'readers', members: ['alice'], hiddenTabs: ['server:sql', 'db:export'] })
      expect(z.array(UserGroupSchema).parse(await saved.json())).toMatchObject([{ name: 'readers' }])
      await h.login('alice', false)
      expect(await (await h.req('/api/user-groups/mine')).json()).toEqual({ hiddenTabs: ['db:export', 'server:sql'] })
      // A member who cannot manage the others does not see the group itself (it names accounts).
      expect(await (await h.req('/api/user-groups')).json()).toEqual([])
      await h.login('bob', false)
      expect(await (await h.req('/api/user-groups/mine')).json()).toEqual({ hiddenTabs: [] })
    } finally {
      await h.store.closeAll()
    }
  })

  it('lets only an account that can manage the members change or delete a group', async () => {
    const h = sharedHarness()
    try {
      await h.login('root')
      const [group] = z
        .array(UserGroupSchema)
        .parse(await (await h.save({ name: 'readers', members: ['alice'], hiddenTabs: [] })).json())
      await h.login('alice', false)
      // Neither by replacing it under the same name nor by deleting it: alice could lift her own restriction.
      expect((await h.save({ name: 'readers', members: ['alice'], hiddenTabs: [] })).status).toBe(403)
      expect((await h.req(`/api/user-groups/${group?.id}`, { method: 'DELETE' })).status).toBe(403)
      await h.login('root')
      expect(await (await h.req(`/api/user-groups/${group?.id}`, { method: 'DELETE' })).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('refuses an unknown tab, and a group without members', async () => {
    const h = sharedHarness()
    try {
      await h.login('root')
      expect((await h.save({ name: 'x', members: ['a'], hiddenTabs: ['server:security'] })).status).toBe(400)
      expect((await h.save({ name: 'x', members: [], hiddenTabs: [] })).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('has nothing to hide, and refuses to save, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/user-groups/mine')).json()).toEqual({ hiddenTabs: [] })
    const res = await h.req('/api/user-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', members: ['a'], hiddenTabs: [] }),
    })
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('change tracking', () => {
  function trackingHarness() {
    // One set of tables behind every session, so a change to it is seen by all of them.
    const users = fakeTable('users', ['id', 'name'], [{ id: 1, name: 'Alice' }])
    users.definition = 'CREATE TABLE users (\n  id int,\n  name text\n)'
    const tables = { users }
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => new FakeAdapter({ databases: { shop: { tables } } }),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (user = 'root') => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify({ ...LOGIN, user }) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    }
    const state = async (method = 'GET', table = 'users') =>
      req(`/api/databases/shop/tables/${table}/tracking`, { method })
    return { store, users, login, state, req }
  }

  it('records versions only when the definition changed, shared by every account of the server', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      expect(TrackingStateSchema.parse(await (await h.state()).json()).versions).toEqual([])
      const first = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(first.versions).toMatchObject([{ version: 1, by: 'root', table: 'users' }])
      // Nothing changed: no second version.
      expect(TrackingStateSchema.parse(await (await h.state('POST')).json()).versions).toHaveLength(1)
      h.users.definition = 'CREATE TABLE users (\n  id int,\n  name varchar(20)\n)'
      // Another account records the next one, and sees the first.
      await h.login('reader')
      const second = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(second.versions.map((v) => [v.version, v.by])).toEqual([
        [1, 'root'],
        [2, 'reader'],
      ])
      expect(second.versions[1]?.definition).toContain('varchar(20)')
      expect(TrackingStateSchema.parse(await (await h.state('DELETE')).json()).versions).toEqual([])
      expect(TrackingStateSchema.parse(await (await h.state()).json()).versions).toEqual([])
      // A definition too long to keep is refused rather than stored.
      h.users.definition = 'x'.repeat(TRACKING_DEFINITION_MAX + 1)
      expect(await (await h.state('POST')).json()).toMatchObject({ code: 'UNSUPPORTED' })
      expect(TrackingStateSchema.parse(await (await h.state()).json()).versions).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('records the statement kinds chosen for a tracked table, and grid edits without their values', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      const sql = (text: string) =>
        h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
      const kinds = (list: string[]) =>
        h.req('/api/databases/shop/tables/users/tracking/kinds', {
          method: 'PUT',
          body: JSON.stringify({ kinds: list }),
        })
      // Not tracked yet: nothing is recorded, and kinds cannot be set.
      await sql('ALTER TABLE users ADD COLUMN a INT')
      expect((await kinds(['alter'])).status).toBe(400)
      // Tracking starts with the definition changes.
      const started = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(started.kinds).toEqual(['create', 'alter', 'rename', 'drop', 'truncate', 'index'])
      await sql('ALTER TABLE `shop`.`users` ADD COLUMN b INT')
      await sql("UPDATE users SET name = 'x'")
      await sql('ALTER TABLE posts ADD COLUMN c INT')
      let log = TrackingStateSchema.parse(await (await h.state()).json()).log ?? []
      expect(log.map((e) => [e.kind, e.statement])).toEqual([['alter', 'ALTER TABLE `shop`.`users` ADD COLUMN b INT']])
      // Row changes, once asked for: the statement from the console, and a grid edit as what it touched.
      await kinds(['alter', 'update'])
      await sql("UPDATE users SET name = 'y'")
      await h.req('/api/databases/shop/tables/users/rows', {
        method: 'PATCH',
        body: JSON.stringify({ key: { kind: 'pk', values: { id: 1 } }, values: { name: 'secret value' } }),
      })
      log = TrackingStateSchema.parse(await (await h.state()).json()).log ?? []
      expect(log.slice(0, 2).map((e) => [e.kind, e.statement, e.columns ?? null])).toEqual([
        ['update', null, ['name']],
        ['update', "UPDATE users SET name = 'y'", null],
      ])
      expect(JSON.stringify(log)).not.toContain('secret value')
      // The database's list of tracked tables.
      const list = await (await h.req('/api/databases/shop/tracking')).json()
      expect(list).toMatchObject([{ table: 'users', versions: 1, latest: 1, kinds: ['alter', 'update'] }])
      // Stopping forgets the settings and the log with the versions.
      await h.state('DELETE')
      expect(await (await h.req('/api/databases/shop/tracking')).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('reveals nothing about a table the account cannot read', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      await h.state('POST')
      // The definition is read through the caller's session first: a table it cannot see answers as missing.
      const missing = await h.state('GET', 'secret')
      expect(missing.status).toBe(404)
      expect(await missing.json()).not.toHaveProperty('versions')
    } finally {
      await h.store.closeAll()
    }
  })

  it('reads, and refuses to record, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/databases/shop/tables/users/tracking')).json()).toMatchObject({ versions: [] })
    const res = await h.req('/api/databases/shop/tables/users/tracking', { method: 'POST' })
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('row functions', () => {
  it('writes through an allowed function and refuses anything else', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const post = (values: unknown) =>
      h.req('/api/databases/shop/tables/users/rows', { method: 'POST', body: JSON.stringify({ values }) })
    expect((await post({ id: 9, name: { $fn: 'upper', arg: 'zed' } })).status).toBe(201)
    // Only the listed functions, and never raw SQL in their place.
    expect((await post({ id: 10, name: { $fn: 'sleep', arg: 5 } })).status).toBe(400)
    expect((await post({ id: 10, name: { $fn: 'upper', arg: 'x', sql: 'DROP' } })).status).toBe(400)
    // A key identifies a row: it is matched, never computed.
    const patch = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: { $fn: 'now' } } }, values: { name: 'x' } }),
    })
    expect(patch.status).toBe(400)
  })
})
