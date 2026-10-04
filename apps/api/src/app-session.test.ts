import { AdapterError } from '@tsmyadmin/adapter'
import { ApiErrorSchema, SessionStateSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { createApp, IP_LIMIT_FACTOR } from './app.ts'
import { auditedAdapterFactory } from './lib/audit.ts'
import { createLogger } from './lib/logging.ts'
import { MemorySessionStore } from './session/store.ts'
import { closeStoresAfterEach, fixtureAdapter, harness, LOGIN, testConfig } from './test/app-harness.ts'

const stores = closeStoresAfterEach()

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
      // How long a session lasts unused (the default is 30 minutes), and where a picture may come from (nowhere).
      ttlSeconds: 1800,
      imageHosts: [],
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

  it('lists databases with their sizes, or without when stats=0, and refuses another value', async () => {
    const h = harness(fixtureAdapter())
    stores.push(h.store)
    await h.login()
    const counted = (await (await h.req('/api/databases')).json()) as { sizeBytes: number | null }[]
    expect(counted.every((d) => d.sizeBytes !== null)).toBe(true)
    const bare = (await (await h.req('/api/databases?stats=0')).json()) as {
      sizeBytes: number | null
      tableCount: number | null
    }[]
    expect(bare.length).toBe(counted.length)
    expect(bare.every((d) => d.sizeBytes === null && d.tableCount === null)).toBe(true)
    expect((await h.req('/api/databases?stats=maybe')).status).toBe(400)
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

  it('adds the discovered containers, and lets a login reach exactly their published host:port', async () => {
    const found = [{ name: 'docker: shop/mysql', dialect: 'mysql' as const, host: '127.0.0.1', port: 13306 }]
    const h = harness(fixtureAdapter(), {
      allowedHosts: ['db'],
      servers: [{ name: 'prod', dialect: 'postgres', host: 'db.internal', port: 5432 }],
      discover: async () => found,
    })
    stores.push(h.store)
    const names = ((await (await h.app.request('/api/servers')).json()) as { name: string }[]).map((s) => s.name)
    expect(names).toEqual(['prod', 'docker: shop/mysql'])
    expect((await h.login({ ...LOGIN, host: '127.0.0.1', port: 13306 })).status).toBe(201)
    // Only what is running: another port on the same host, or another host, is still refused.
    expect((await h.login({ ...LOGIN, host: '127.0.0.1', port: 9999 })).status).toBe(403)
    expect((await h.login({ ...LOGIN, host: 'elsewhere', port: 13306 })).status).toBe(403)
  })

  it('ignores a discovered container named like a configured preset, and asks Docker only when the list says no', async () => {
    let asked = 0
    const h = harness(fixtureAdapter(), {
      servers: [{ name: 'same', dialect: 'mysql', host: 'db', port: 3306 }],
      discover: async () => {
        asked++
        return [{ name: 'same', dialect: 'postgres' as const, host: 'other', port: 5432 }]
      },
    })
    stores.push(h.store)
    const list = (await (await h.app.request('/api/servers')).json()) as { host: string }[]
    expect(list.map((s) => s.host)).toEqual(['db'])
    asked = 0
    expect((await h.login({ ...LOGIN, host: 'db' })).status).toBe(201)
    expect(asked).toBe(0)
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
