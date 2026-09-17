/**
 * The same checks against every shape of front end tsmyadmin is deployed behind.
 *
 * Platforms differ only in how they tell the app who the client is, and each difference fails silently: a client
 * identified wrongly still gets served, it just lands in the wrong rate-limit bucket, which is only noticed when
 * brute-force protection turns out not to work. So each platform here is asserted on behaviour — can a visitor be
 * limited, and can they be limited *without* taking anyone else down with them — rather than on the parsed value
 * alone.
 *
 * Adding a platform to docs/hosting.md means adding a row here.
 */
import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { createApp, IP_LIMIT_FACTOR } from './app.ts'
import { type AppConfig, loadConfig } from './config.ts'
import type { TrustProxy } from './lib/logging.ts'
import { MemorySessionStore } from './session/store.ts'

const SECRET = 'test-secret'
const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'root', password: 'pw' }
const RATE_LIMIT = 3

interface Platform {
  name: string
  trustProxy: TrustProxy
  /** What the socket sees: the front end's address, or the client's when nothing sits in front. */
  remote: (client: string) => string
  /**
   * Headers the front end puts on the request. `attempt` increments per request so a platform that varies
   * something per connection — Azure App Service appends the source port — actually varies it here.
   */
  headers: (client: string, attempt: number) => Record<string, string>
  /**
   * Headers this platform does NOT vouch for, which a client is therefore free to set itself. Believing one hands
   * every visitor a way to choose their own rate-limit bucket, so the tests send a different forged address on
   * every attempt: an implementation that trusts these never reaches the limit.
   */
  decoy: (forged: string) => Record<string, string>
  /** IPv4 clients unless stated. Bare IPv6 is the case an address-parsing slip collapses into one bucket. */
  ipv6?: boolean
}

/**
 * A trusted front end overwrites its own header, so a client-supplied one only ever appears in addition.
 *
 * `x-real-ip` and `forwarded` are on every row: no platform here vouches for either, so believing one would be
 * the same bug as believing the rest, and both are headers an implementation might plausibly reach for.
 */
const forgedCommon = (forged: string) => ({ 'x-real-ip': forged, forwarded: `for=${forged}` })
const forgedXff = (forged: string) => ({ ...forgedCommon(forged), 'x-forwarded-for': forged })
const forgedCf = (forged: string) => ({ ...forgedCommon(forged), 'cf-connecting-ip': forged })
const forgedBoth = (forged: string) => ({ ...forgedXff(forged), ...forgedCf(forged) })

const PLATFORMS: Platform[] = [
  {
    // nginx / Caddy on an ordinary server: Sakura VPS, ConoHa, EC2, Lightsail, Azure VM.
    name: 'reverse proxy on a server',
    trustProxy: 'forwarded',
    decoy: forgedCf,
    remote: () => '10.0.0.1',
    headers: (client) => ({ 'x-forwarded-for': client, 'x-forwarded-proto': 'https' }),
  },
  {
    // An ALB appends the client to any X-Forwarded-For already present, so the last element is the client.
    name: 'AWS ALB',
    trustProxy: 'forwarded',
    decoy: forgedCf,
    remote: () => '10.0.0.2',
    headers: (client) => ({ 'x-forwarded-for': client, 'x-forwarded-proto': 'https' }),
  },
  {
    name: 'AWS App Runner',
    trustProxy: 'forwarded',
    decoy: forgedCf,
    remote: () => '10.0.0.3',
    headers: (client) => ({ 'x-forwarded-for': client, 'x-forwarded-proto': 'https' }),
  },
  {
    // The distinguishing case: the source port rides along, and it changes on every connection.
    name: 'Azure App Service',
    trustProxy: 'forwarded',
    decoy: forgedCf,
    remote: () => '10.0.0.4',
    headers: (client, attempt) => ({
      'x-forwarded-for': `${client}:${40000 + attempt}`,
      'x-forwarded-proto': 'https',
    }),
  },
  {
    name: 'Azure Container Apps',
    trustProxy: 'forwarded',
    decoy: forgedCf,
    remote: () => '10.0.0.5',
    headers: (client) => ({ 'x-forwarded-for': client, 'x-forwarded-proto': 'https' }),
  },
  {
    // The Worker sets X-Forwarded-Proto itself, because the container library rewrites https: to http:.
    name: 'Cloudflare Containers',
    trustProxy: 'cloudflare',
    // Cloudflare overwrites CF-Connecting-IP but passes X-Forwarded-For through, so a client can write that one.
    decoy: forgedXff,
    // Cloudflare serves IPv6 visitors, and a naive port-strip would collapse a whole /64 into one bucket.
    ipv6: true,
    remote: () => '10.0.0.6',
    headers: (client) => ({ 'cf-connecting-ip': client, 'x-forwarded-proto': 'https' }),
  },
  {
    // A client that writes its own X-Forwarded-For before the real proxy appends to it.
    name: 'reverse proxy, client forging a prefix',
    trustProxy: 'forwarded',
    decoy: forgedCf,
    remote: () => '10.0.0.7',
    headers: (client) => ({
      'x-forwarded-for': `203.0.113.250, 198.51.100.250, ${client}`,
      'x-forwarded-proto': 'https',
    }),
  },
  {
    // No proxy at all: the socket address is the only thing that can be believed. TLS has to be terminated
    // somewhere, so this shape is only viable with COOKIE_SECURE=0 on a closed network.
    name: 'no proxy (COOKIE_SECURE=0)',
    trustProxy: 'none',
    // Nothing is in front, so every one of these is the client's own words and none may be believed.
    decoy: forgedBoth,
    remote: (client) => client,
    headers: () => ({}),
  },
]

function harness(platform: Platform) {
  // Flipped per request: a run needs both a real sign-in and a run of failures, and only a failure is counted.
  let refuse = false
  const store = new MemorySessionStore({
    adapterFactory: () => new FakeAdapter(refuse ? { failWith: new AdapterError('AUTH_FAILED', 'denied') } : {}),
    sweepIntervalMs: 0,
  })
  const logged: Record<string, unknown>[] = []
  const config: AppConfig = {
    ...loadConfig({}),
    sessionSecret: SECRET,
    allowedHosts: ['db'],
    isProd: true,
    // The no-proxy shape cannot present HTTPS, which is exactly the configuration that setting exists for.
    cookieSecure: platform.trustProxy !== 'none',
    trustProxy: platform.trustProxy,
    loginRateLimit: { max: RATE_LIMIT, windowMs: 60_000 },
  }
  const app = createApp(config, {
    store,
    remoteAddress: () => platform.remote(currentClient),
    logger: { log: (_level, _event, fields = {}) => void logged.push(fields) },
  })
  let currentClient = '203.0.113.1'
  let attempt = 0
  const post = (client: string, body: Record<string, unknown>, options: { refuse?: boolean } = {}) => {
    currentClient = client
    refuse = options.refuse ?? false
    attempt += 1
    return app.request('/api/session', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        // Written first so the front end's own headers overwrite them, exactly as a real one would.
        ...platform.decoy(`198.51.100.${attempt}`),
        ...platform.headers(client, attempt),
      },
    })
  }
  /** Addresses the app actually believed. Events without an `ip` field (startup, audit) are not requests. */
  const seenIps = () => new Set(logged.map((f) => f.ip).filter((ip) => ip !== undefined))
  return { store, post, logged, seenIps }
}

describe.each(PLATFORMS)('behind $name', (platform) => {
  it('identifies the client, so one visitor can be rate limited without affecting another', async () => {
    const h = harness(platform)
    try {
      const [alice, bob] = platform.ipv6 ? ['2001:db8::11', '2001:db8::22'] : ['203.0.113.11', '203.0.113.22']

      // A login must be accepted at all: with cookieSecure on, a front end that does not present HTTPS to the
      // app would refuse every one of these with INSECURE_TRANSPORT.
      expect((await h.post(alice, LOGIN)).status).toBe(201)

      // Exhaust Alice's per-user bucket. Every one is refused, so nothing resets the counter.
      let aliceLimited = false
      for (let i = 0; i < RATE_LIMIT + 1; i++) {
        if ((await h.post(alice, LOGIN, { refuse: true })).status === 429) aliceLimited = true
      }
      expect(aliceLimited).toBe(true)

      // The point of the whole exercise: Bob is a different visitor and must still get through. If the client
      // were misidentified — a per-connection port kept, or everyone collapsed onto the proxy's address — this
      // is what would fail, silently, in production.
      expect((await h.post(bob, LOGIN)).status).toBe(201)

      // Exactly these two, so a fallback to the front end's own address on some requests cannot hide here.
      expect(h.seenIps()).toEqual(new Set([alice, bob]))
    } finally {
      await h.store.closeAll()
    }
  })

  it('counts failures per address, so rotating the user name does not buy a fresh window', async () => {
    const h = harness(platform)
    try {
      const mallory = platform.ipv6 ? '2001:db8::33' : '203.0.113.33'
      let limited = false
      // Each attempt uses a new user name, which defeats the per-user bucket by design; the per-IP bucket is
      // what has to stop it, and it can only do that if the address is read consistently.
      for (let i = 0; i < RATE_LIMIT * IP_LIMIT_FACTOR + 1; i++) {
        const res = await h.post(mallory, { ...LOGIN, user: `u${i}` }, { refuse: true })
        if (res.status === 429) limited = true
      }
      expect(limited).toBe(true)
    } finally {
      await h.store.closeAll()
    }
  })
})
