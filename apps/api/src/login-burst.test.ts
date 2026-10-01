import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { createApp, IP_LIMIT_FACTOR } from './app.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './lib/logging.ts'
import { RateLimiter } from './lib/rate-limit.ts'
import { MemorySessionStore } from './session/store.ts'

const SECRET = 's'.repeat(32)
const PER_USER = 10
const PER_IP = PER_USER * IP_LIMIT_FACTOR

type Outcome = 'wrong-password' | 'ok' | 'store-down'

/** An app whose connection attempt takes a moment, like a real database server, and whose outcome the test picks. */
function harness() {
  const store = new MemorySessionStore({ adapterFactory: () => new FakeAdapter(), sweepIntervalMs: 0 })
  const realCreate = store.create.bind(store)
  let outcome: Outcome = 'wrong-password'
  let attempts = 0
  store.create = (async (...args: Parameters<typeof realCreate>) => {
    attempts++
    await new Promise((resolve) => setTimeout(resolve, 15))
    if (outcome === 'wrong-password') throw new AdapterError('AUTH_FAILED', 'Access denied')
    if (outcome === 'store-down') {
      throw Object.assign(new Error('Reached the max retries per request limit (which is 3).'), {
        name: 'MaxRetriesPerRequestError',
      })
    }
    return realCreate(...args)
  }) as typeof store.create
  const config = {
    ...loadConfig({}),
    sessionSecret: SECRET,
    allowedHosts: ['db'],
    loginRateLimit: { max: PER_USER, windowMs: 60_000 },
  }
  const app = createApp(config, { store, logger: createLogger('json', () => undefined) })
  const login = (user: string) =>
    app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dialect: 'mysql', host: 'db', port: 3306, user, password: 'pw' }),
    })
  const tally = (rs: Response[]) =>
    rs.reduce<Record<number, number>>((m, r) => {
      m[r.status] = (m[r.status] ?? 0) + 1
      return m
    }, {})
  return {
    store,
    login,
    tally,
    attempts: () => attempts,
    set: (o: Outcome) => {
      outcome = o
    },
    burst: (n: number, prefix = 'user') => Promise.all(Array.from({ length: n }, (_, i) => login(`${prefix}${i}`))),
  }
}

describe('the per-IP login limit', () => {
  it('holds against a burst of parallel attempts with different user names', async () => {
    const h = harness()
    const rs = await h.burst(100)
    // Every attempt used to pass a check that only knew the failures recorded after earlier attempts had finished.
    expect(h.attempts()).toBe(PER_IP)
    expect(h.tally(rs)).toEqual({ 401: PER_IP, 429: 100 - PER_IP })
    await h.store.closeAll()
  })

  it('is not used up by successful logins from the same address', async () => {
    const h = harness()
    h.set('ok')
    const ok = await h.burst(20, 'good')
    expect(h.tally(ok)).toEqual({ 201: 20 })
    h.set('wrong-password')
    const before = h.attempts()
    await h.burst(40, 'bad')
    // All of the budget is still there: the successes gave their slots back.
    expect(h.attempts() - before).toBe(PER_IP)
    await h.store.closeAll()
  })

  it('is not used up by attempts the per-user limit already refused', async () => {
    const h = harness()
    const same = await Promise.all(Array.from({ length: 15 }, () => h.login('target')))
    expect(h.tally(same)).toEqual({ 401: PER_USER, 429: 15 - PER_USER })
    const before = h.attempts()
    await h.burst(40, 'other')
    // Only the ten that were really tried count against the address.
    expect(h.attempts() - before).toBe(PER_IP - PER_USER)
    await h.store.closeAll()
  })

  it('does not count a session store that is down as a wrong guess', async () => {
    const h = harness()
    h.set('store-down')
    // More attempts than the budget, one after another: all of them are the server's trouble, none the client's.
    const statuses: number[] = []
    for (let i = 0; i < PER_IP + 10; i++) statuses.push((await h.login(`user${i}`)).status)
    expect(new Set(statuses)).toEqual(new Set([503]))
    await h.store.closeAll()
  })
})

describe('RateLimiter.refund', () => {
  it('gives one attempt back within its window', () => {
    const rl = new RateLimiter(2, 1000, () => 0, 0)
    const a = rl.hit('k')
    rl.hit('k')
    expect(rl.peek('k').allowed).toBe(false)
    rl.refund('k', a.windowEnd)
    expect(rl.peek('k').allowed).toBe(true)
  })

  it('ignores an attempt counted in a window that has ended', () => {
    let t = 0
    const rl = new RateLimiter(2, 1000, () => t, 0)
    const old = rl.hit('k')
    t = 2000
    rl.hit('k')
    rl.hit('k')
    rl.refund('k', old.windowEnd)
    // The new window saw two attempts; the refund of the old one must not take one of them away.
    expect(rl.peek('k').allowed).toBe(false)
  })
})
