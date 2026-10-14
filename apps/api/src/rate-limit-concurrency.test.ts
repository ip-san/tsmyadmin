import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import type { ConnectRequest } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, IP_LIMIT_FACTOR } from './app.ts'
import { MemorySessionStore } from './session/store.ts'
import { capture, testConfig } from './test/app-harness.ts'
import { concurrently, countStatuses, fulfilled } from './test/concurrency-harness.ts'

const PER_USER = 5
const PER_IP = PER_USER * IP_LIMIT_FACTOR

/** A server that takes a moment to answer and accepts only the password `right`; it counts what reached it. */
class SlowServer extends FakeAdapter {
  constructor(
    private readonly config: ConnectRequest,
    private readonly reached: ConnectRequest[]
  ) {
    super()
  }

  override async ping(): Promise<void> {
    this.reached.push(this.config)
    await new Promise((resolve) => setTimeout(resolve, 3))
    if (this.config.password !== 'right') throw new AdapterError('AUTH_FAILED', 'Access denied')
  }
}

const stores: MemorySessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})

function harness() {
  const reached: ConnectRequest[] = []
  const store = new MemorySessionStore({
    adapterFactory: (config) => new SlowServer(config, reached),
    sweepIntervalMs: 0,
  })
  stores.push(store)
  const app = createApp(testConfig({ loginRateLimit: { max: PER_USER, windowMs: 60_000 } }), {
    store,
    logger: capture().logger,
    // The address a request came from, as the test names it.
    remoteAddress: (c) => c.req.header('x-test-ip'),
  })
  const login = (ip: string, user: string, password: string) =>
    app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-ip': ip },
      body: JSON.stringify({ dialect: 'mysql', host: 'db', port: 3306, user, password }),
    })
  const wrongFrom = (ip: string) => reached.filter((c) => c.password !== 'right' && `${c.user}`.startsWith(ip)).length
  return { login, reached, wrongFrom }
}

describe('the login limits under bursts', () => {
  it('lets no more wrong guesses reach the server than the address may make, with right logins mixed in', async () => {
    const h = harness()
    const n = PER_IP * 3
    const rs = fulfilled(
      await concurrently(n, (i) =>
        i % 2 === 0 ? h.login('10.0.0.1', `10.0.0.1-u${i}`, 'wrong') : h.login('10.0.0.1', `10.0.0.1-u${i}`, 'right')
      )
    )
    expect(h.wrongFrom('10.0.0.1')).toBeLessThanOrEqual(PER_IP)
    // Every answer is one of: logged in, wrong password, or turned away before reaching the server.
    expect(rs.every((r) => [201, 401, 429].includes(r.status))).toBe(true)
    // Right logins give their slot back, so they do not use up the budget the wrong ones are counted against.
    expect(countStatuses(rs)[201]).toBeGreaterThan(0)
    expect(countStatuses(rs)[401]).toBe(h.wrongFrom('10.0.0.1'))
  })

  it('counts each address on its own: bursts from two addresses each stay within their own budget', async () => {
    const h = harness()
    const ips = ['10.0.0.1', '10.0.0.2']
    const n = PER_IP * 2
    const rs = fulfilled(
      await concurrently(n * ips.length, (i) => {
        const ip = ips[i % ips.length] ?? ''
        return h.login(ip, `${ip}-u${i}`, 'wrong')
      })
    )
    for (const ip of ips) expect(h.wrongFrom(ip)).toBe(PER_IP)
    expect(countStatuses(rs)).toEqual({ 401: PER_IP * ips.length, 429: (n - PER_IP) * ips.length })
  })

  it('lets no more guesses at one user reach the server than the per-user limit, from one address or many', async () => {
    const h = harness()
    const n = PER_USER * 4
    const rs = fulfilled(await concurrently(n, (i) => h.login(`10.0.1.${i}`, 'target', 'wrong')))
    expect(h.reached.filter((c) => c.user === 'target')).toHaveLength(n)
    // The per-user window is per address and user: spreading over addresses gives each its own few tries, but one
    // address bursting at one user gets only its budget.
    const one = fulfilled(await concurrently(n, () => h.login('10.0.2.1', 'other', 'wrong')))
    expect(h.reached.filter((c) => c.user === 'other')).toHaveLength(PER_USER)
    expect(countStatuses(one)).toEqual({ 401: PER_USER, 429: n - PER_USER })
    expect(countStatuses(rs)).toEqual({ 401: n })
  })
})
