import { createHash } from 'node:crypto'
import { AdapterError } from '@tsmyadmin/adapter'
import { ConnectRequestSchema, type ServerPreset } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { createApp, IP_LIMIT_FACTOR } from './app.ts'
import { codeFor, stepAt } from './lib/totp.ts'
import { MAX_MISSES } from './session/second-factor-lock.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { MemorySessionStore } from './session/store.ts'
import { closeStoresAfterEach, fixtureAdapter, harness, LOGIN, testConfig } from './test/app-harness.ts'
import { capture, eventsOf as events, totpHarness } from './test/totp-harness.ts'

/**
 * The words, the log lines and the limits of signing in and out, and the bookmark and template routes, as the
 * operator and the person at the login screen meet them (found as surviving mutants; see `bun run mutation`).
 */

const stores = closeStoresAfterEach()

const sessionIdOf = (res: Response) => {
  const value = res.headers.get('set-cookie')?.split(';')[0]?.split('=')[1] ?? ''
  return decodeURIComponent(value).split('.')[0] ?? ''
}
const errorOf = async (res: Response) => (await res.json()) as { code: string; message: string; passkey?: unknown }

describe('refusing a login: what is said and what is written', () => {
  const audit = { dialect: 'mysql', host: 'db', port: 3306, user: 'root' }

  it('names the host that is not allowed, in the answer and in the log, without the password', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter(), { logger })
    stores.push(h.store)
    const res = await h.login({ ...LOGIN, host: 'evil.example', port: 3307 })
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toMatchObject({
      code: 'HOST_NOT_ALLOWED',
      message: 'Connections to "evil.example:3307" are not allowed (TSMYADMIN_ALLOWED_HOSTS)',
    })
    const [line] = events(lines, 'login.host_not_allowed')
    expect(line).toMatchObject({
      level: 'warn',
      dialect: 'mysql',
      host: 'evil.example',
      port: 3307,
      user: 'root',
      requestId: expect.any(String),
      ip: expect.any(String),
    })
    expect(JSON.stringify(lines)).not.toContain('"pw"')
  })

  it('says "Authentication failed" for a wrong password whatever the server said, and logs a failed login', async () => {
    const { lines, logger } = capture()
    const h = harness(
      fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', "Access denied for user 'root'@'10.1.2.3'") }),
      {
        logger,
      }
    )
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(401)
    expect(await errorOf(res)).toMatchObject({ code: 'AUTH_FAILED', message: 'Authentication failed' })
    expect(events(lines, 'login.failed')).toMatchObject([{ level: 'warn', ...audit }])
  })

  it('says the server refused this host only for the host-ACL errors, and not for any other connection failure', async () => {
    const acl = harness(
      fixtureAdapter({
        failWith: new AdapterError('CONNECTION_FAILED', "Host '10.1.2.3' is not allowed", undefined, {
          nativeCode: 'ER_HOST_NOT_PRIVILEGED',
        }),
      })
    )
    stores.push(acl.store)
    const refused = await acl.login()
    expect(refused.status).toBe(502)
    expect(await errorOf(refused)).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: 'The server refused connections from this host',
    })
    const down = harness(fixtureAdapter({ failWith: new AdapterError('CONNECTION_FAILED', 'ECONNREFUSED') }))
    stores.push(down.store)
    const res = await down.login()
    expect(res.status).toBe(502)
    expect((await errorOf(res)).message).not.toBe('The server refused connections from this host')
    // A native code that is not an ACL one does not count either.
    const other = harness(
      fixtureAdapter({
        failWith: new AdapterError('CONNECTION_FAILED', 'boom', undefined, { nativeCode: 'ECONNRESET' }),
      })
    )
    stores.push(other.store)
    expect((await errorOf(await other.login())).message).not.toBe('The server refused connections from this host')
  })

  it('tells a production login over plain HTTP to use HTTPS, and logs it', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter(), { isProd: true, logger })
    stores.push(h.store)
    const res = await h.app.request('http://admin.example.com/api/session', {
      method: 'POST',
      body: JSON.stringify(LOGIN),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({
      code: 'INSECURE_TRANSPORT',
      message: 'The session cookie is Secure: log in over HTTPS (or set COOKIE_SECURE=0)',
    })
    expect(events(lines, 'login.insecure_transport')).toMatchObject([{ level: 'warn', ...audit }])
    // Nothing was counted: the same caller is not rate limited for it.
    expect(events(lines, 'login.rate_limited')).toEqual([])
  })

  it('answers a user over the limit with the wait and the words, and logs it', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      logger,
      loginRateLimit: { max: 1, windowMs: 60_000 },
    })
    stores.push(h.store)
    await h.login()
    const res = await h.login()
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await errorOf(res)).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many login attempts; try again later',
    })
    expect(events(lines, 'login.rate_limited')).toMatchObject([{ level: 'warn', ...audit }])
  })

  it('answers an address over the limit with the same words, and logs it', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') }), {
      logger,
      loginRateLimit: { max: 1, windowMs: 60_000 },
    })
    stores.push(h.store)
    for (let i = 0; i < IP_LIMIT_FACTOR; i++) await h.login({ ...LOGIN, user: `u${i}` })
    const res = await h.login({ ...LOGIN, user: 'fresh' })
    expect(res.status).toBe(429)
    expect(await errorOf(res)).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many login attempts; try again later',
    })
    expect(events(lines, 'login.rate_limited')).toMatchObject([{ level: 'warn', user: 'fresh' }])
  })

  it('gives a user a fresh budget after a login that works', async () => {
    // Wrong password first, then the right one: with two tries allowed, the right one must not leave the wrong
    // one on the count, or the next wrong-then-right pair would be refused.
    const adapter = fixtureAdapter()
    const store = new MemorySessionStore({
      adapterFactory: (config) => {
        if (config.password !== 'pw') throw new AdapterError('AUTH_FAILED', 'denied')
        return adapter
      },
      sweepIntervalMs: 0,
    })
    stores.push(store)
    const app = createApp(testConfig({ loginRateLimit: { max: 2, windowMs: 60_000 } }), { store })
    const post = (password: string) =>
      app.request('/api/session', {
        method: 'POST',
        body: JSON.stringify({ ...LOGIN, password }),
        headers: { 'content-type': 'application/json' },
      })
    const statuses: number[] = []
    for (const password of ['bad', 'pw', 'bad', 'pw', 'bad', 'pw']) statuses.push((await post(password)).status)
    expect(statuses).toEqual([401, 201, 401, 201, 401, 201])
  })
})

describe('signing in and out: what is written', () => {
  it('logs a login with the identity and a short hash of the session, never the session itself', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter(), { logger })
    stores.push(h.store)
    const res = await h.login()
    expect(res.status).toBe(201)
    const id = sessionIdOf(res)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const tag = createHash('sha256').update(id).digest('hex').slice(0, 16)
    const [line] = events(lines, 'login.ok')
    expect(line).toMatchObject({
      level: 'info',
      ...{ dialect: 'mysql', host: 'db', port: 3306, user: 'root' },
      sessionId: tag,
    })
    expect(line?.sessionId).toHaveLength(16)
    expect(JSON.stringify(lines)).not.toContain(id)
  })

  it('logs a logout the same way, clears the cookie for the whole site, and says ok', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter(), { logger })
    stores.push(h.store)
    const id = sessionIdOf(await h.login())
    const res = await h.req('/api/session', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toMatch(/Path=\//)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect(events(lines, 'logout')).toMatchObject([
      {
        level: 'info',
        requestId: expect.any(String),
        sessionId: createHash('sha256').update(id).digest('hex').slice(0, 16),
      },
    ])
  })

  it('logs nothing for a logout that had no session to end, and still says ok', async () => {
    const { lines, logger } = capture()
    const h = harness(fixtureAdapter(), { logger })
    stores.push(h.store)
    const res = await h.req('/api/session', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(events(lines, 'logout')).toEqual([])
  })

  it('tells the page where pictures may come from, as configured', async () => {
    const store = new MemorySessionStore({ adapterFactory: () => fixtureAdapter(), sweepIntervalMs: 0 })
    stores.push(store)
    const app = createApp(testConfig({ imageHosts: ['img.example.com'] }), { store })
    const res = await app.request('/api/session', {
      method: 'POST',
      body: JSON.stringify(LOGIN),
      headers: { 'content-type': 'application/json' },
    })
    expect(((await res.json()) as { imageHosts: string[] }).imageHosts).toEqual(['img.example.com'])
  })
})

describe('signing in to a Docker container', () => {
  const PRESET: ServerPreset = {
    name: 'docker: a/db',
    dialect: 'mysql',
    host: '127.0.0.1',
    port: 13306,
    autoLogin: true,
  }
  const build = (preset: ServerPreset) => {
    const seen: Record<string, unknown>[] = []
    const store = new MemorySessionStore({
      adapterFactory: (config) => {
        seen.push(config)
        return fixtureAdapter()
      },
      sweepIntervalMs: 0,
    })
    stores.push(store)
    const app = createApp(testConfig({ allowedHosts: [] }), {
      store,
      discover: async () => [preset],
      dockerLogin: async (name: string) =>
        name === preset.name ? { preset, login: { user: 'root', password: 'container-secret' } } : null,
    })
    const post = (body: Record<string, unknown>) =>
      app.request('/api/session', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      })
    return { seen, post }
  }
  const request = { dialect: 'mysql', host: 'x', port: 1, user: 'u', password: 'p', dockerPreset: PRESET.name }

  it('uses the container database only when the request names none, and none when the container has none', async () => {
    const withDb = build({ ...PRESET, database: 'app' })
    expect((await withDb.post(request)).status).toBe(201)
    expect(withDb.seen[0]).toMatchObject({ database: 'app' })
    const named = build({ ...PRESET, database: 'app' })
    await named.post({ ...request, database: 'mine' })
    expect(named.seen[0]).toMatchObject({ database: 'mine' })
    const bare = build(PRESET)
    expect((await bare.post(request)).status).toBe(201)
    expect(bare.seen[0]).not.toHaveProperty('database')
  })

  it('says no login is held for a container it does not know', async () => {
    const h = build(PRESET)
    const res = await h.post({ ...request, dockerPreset: 'docker: other/db' })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({
      code: 'VALIDATION',
      message: 'No login is held for that Docker container',
    })
  })
})

describe('signing in with a second factor: what is said and written', () => {
  it('asks for a code when there is none, with the words and a log line, and no passkey offer when it has none', async () => {
    const h = totpHarness()
    try {
      await h.enrol()
      const res = await h.browser().login()
      expect(res.status).toBe(401)
      const body = await errorOf(res)
      expect(body).toMatchObject({
        code: 'SECOND_FACTOR_REQUIRED',
        message: 'This account needs a one-time code or a passkey',
      })
      expect(body).not.toHaveProperty('passkey')
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(events(h.lines, 'login.second_factor.missing')).toMatchObject([{ level: 'warn', user: 'root' }])
      expect(events(h.lines, 'login.second_factor.failed')).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('refuses a wrong code with the words and a different log line, and leaves no session behind', async () => {
    const h = totpHarness()
    try {
      await h.enrol()
      const res = await h.browser().login({ ...LOGIN, code: '000000' })
      expect(res.status).toBe(401)
      expect(await errorOf(res)).toMatchObject({ code: 'SECOND_FACTOR_INVALID', message: 'That code is not valid' })
      expect(events(h.lines, 'login.second_factor.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
      expect(events(h.lines, 'login.second_factor.missing')).toEqual([])
      expect(res.headers.get('set-cookie')).toBeNull()
    } finally {
      await h.store.closeAll()
    }
  })

  it('says to try later when the account is locked, with the wait and a log line', async () => {
    const h = totpHarness({ loginRateLimit: { max: 100, windowMs: 60_000 } })
    try {
      const { code } = await h.enrol()
      for (let i = 0; i < MAX_MISSES; i++) await h.browser().login({ ...LOGIN, code: '000000' })
      const res = await h.browser().login({ ...LOGIN, code })
      expect(res.status).toBe(429)
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(await errorOf(res)).toMatchObject({
        code: 'RATE_LIMITED',
        message: 'Too many code attempts; try again later',
      })
      expect(events(h.lines, 'login.second_factor.locked')).toMatchObject([{ level: 'warn', user: 'root' }])
    } finally {
      await h.store.closeAll()
    }
  })

  it('counts a refused code against the address, as a wrong password is', async () => {
    const h = totpHarness({ loginRateLimit: { max: 1, windowMs: 60_000 } })
    try {
      await h.enrol()
      // The address allows `max * factor` failures in the window; a refused code is one of them, like a wrong
      // password of another user name (here the fake server refuses every user but root).
      expect((await h.browser().login({ ...LOGIN, code: '000000' })).status).toBe(401)
      for (let i = 1; i < IP_LIMIT_FACTOR; i++) {
        expect((await h.browser().login({ ...LOGIN, user: `other${i}` })).status).toBe(401)
      }
      expect((await h.browser().login({ ...LOGIN, user: 'another' })).status).toBe(429)
    } finally {
      await h.store.closeAll()
    }
  })

  it('closes the oldest session of an account beyond its limit once the code is right', async () => {
    const h = totpHarness({ maxPerIdentity: 1 })
    try {
      const { secret } = await h.enrol()
      const a = h.browser()
      const b = h.browser()
      // A code is good once: each login waits for the next one.
      const code = () => codeFor(secret, stepAt(h.tick(30_000)))
      expect((await a.login({ ...LOGIN, code: code() })).status).toBe(201)
      expect((await a.req('/api/session')).status).toBe(200)
      expect((await b.login({ ...LOGIN, code: code() })).status).toBe(201)
      expect((await b.req('/api/session')).status).toBe(200)
      expect((await a.req('/api/session')).status).toBe(401)
    } finally {
      await h.store.closeAll()
    }
  })
})

describe('bookmarks and templates without a store that keeps them', () => {
  const post = (h: ReturnType<typeof harness>, path: string, body: unknown) =>
    h.req(path, { method: 'POST', body: JSON.stringify(body) })

  it('says so in the same words for each route that would need one', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const queries = 'Saved queries need a persistent session store'
    const templates = 'Export templates need a persistent session store'
    const cases: [Response, string][] = [
      [await post(h, '/api/saved-queries', { name: 'a', sql: 'SELECT 1' }), queries],
      [await h.req('/api/saved-queries/1', { method: 'DELETE' }), queries],
      [await post(h, '/api/export-templates', { name: 'a', database: 'shop', options: {} }), templates],
      [await h.req('/api/export-templates/1', { method: 'DELETE' }), templates],
    ]
    for (const [res, message] of cases) {
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toMatchObject({ code: 'UNSUPPORTED', message })
    }
  })
})

describe('bookmarks and templates in the store that keeps them', () => {
  function persistent() {
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
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      })
    const login = async () => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(LOGIN) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    }
    const config = ConnectRequestSchema.parse(LOGIN)
    const body = (database: string, schema?: string) =>
      JSON.stringify({ database, ...(schema ? { schema } : {}), tables: ['users'], options: { format: 'sql' } })
    const list = async (kind: 'sql' | 'export') => store.savedQueries.list(config, kind)
    const save = (name: string, template: Record<string, unknown>) =>
      req('/api/export-templates', { method: 'POST', body: JSON.stringify({ name, options: {}, ...template }) })
    return { store, req, login, config, body, list, save }
  }

  it('deleting a bookmark really removes it', async () => {
    const h = persistent()
    try {
      await h.login()
      await h.req('/api/saved-queries', { method: 'POST', body: JSON.stringify({ name: 'daily', sql: 'SELECT 1' }) })
      const [one] = await h.list('sql')
      expect(one).toBeDefined()
      const res = await h.req(`/api/saved-queries/${one?.id}`, { method: 'DELETE' })
      expect(await res.json()).toEqual([])
      expect(await h.list('sql')).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('shows the rows it can read as templates, and neither shows nor deletes the ones it cannot', async () => {
    const h = persistent()
    try {
      await h.login()
      await h.store.savedQueries.save(h.config, 'export', 'readable', h.body('shop'))
      await h.store.savedQueries.save(h.config, 'export', 'not-json', 'this is not json')
      await h.store.savedQueries.save(h.config, 'export', 'wrong-shape', JSON.stringify({ hello: 'world' }))
      const listed = (await (await h.req('/api/export-templates')).json()) as { name: string }[]
      expect(listed.map((t) => t.name)).toEqual(['readable'])
      expect(await h.list('export')).toHaveLength(3)
    } finally {
      await h.store.closeAll()
    }
  })

  it('replaces an old row of the same name and database when it is saved again, and only that one', async () => {
    const h = persistent()
    try {
      await h.login()
      // The shape older versions wrote: the name is the key, the body holds the database.
      await h.store.savedQueries.save(h.config, 'export', 'nightly', h.body('shop'))
      await h.save('nightly', { database: 'blog' })
      // Same name, other database: a second template, the old one untouched.
      expect(await h.list('export')).toHaveLength(2)
      await h.save('weekly', { database: 'shop' })
      // Other name, same database: the old row stays too.
      expect(await h.list('export')).toHaveLength(3)
      await h.save('nightly', { database: 'shop' })
      expect(await h.list('export')).toHaveLength(3)
    } finally {
      await h.store.closeAll()
    }
  })

  it('tells the schemas of one database apart when it looks for the old row', async () => {
    const h = persistent()
    try {
      await h.login()
      await h.store.savedQueries.save(h.config, 'export', 'nightly', h.body('shop', 'a'))
      await h.save('nightly', { database: 'shop', schema: 'b' })
      expect(await h.list('export')).toHaveLength(2)
      await h.save('nightly', { database: 'shop', schema: 'a' })
      expect(await h.list('export')).toHaveLength(2)
    } finally {
      await h.store.closeAll()
    }
  })

  it('leaves an old row it cannot read alone, even when the name is the same', async () => {
    const h = persistent()
    try {
      await h.login()
      await h.store.savedQueries.save(h.config, 'export', 'nightly', 'this is not json')
      await h.save('nightly', { database: 'shop' })
      expect(await h.list('export')).toHaveLength(2)
      expect((await h.list('export')).map((r) => r.body)).toContain('this is not json')
    } finally {
      await h.store.closeAll()
    }
  })
})
