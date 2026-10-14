import { AdapterError } from '@tsmyadmin/adapter'
import { SecondFactorSetupSchema } from '@tsmyadmin/shared'
import { expect } from 'vitest'
import { createApp } from '../app.ts'
import { createLogger } from '../lib/logging.ts'
import { codeFor, stepAt } from '../lib/totp.ts'
import { SqliteSessionStore } from '../session/sqlite-store.ts'
import { fixtureAdapter, LOGIN, PASSKEY_FIXTURE, testConfig } from './app-harness.ts'

/** A logger whose JSON lines the test reads. */
export function capture() {
  const lines: Record<string, unknown>[] = []
  return { lines, logger: createLogger('json', (l) => lines.push(JSON.parse(l))) }
}

/** The lines of one event. */
export const eventsOf = (lines: Record<string, unknown>[], event: string) => lines.filter((l) => l.event === event)

/**
 * The persistent store, a clock held by hand, and a second factor: the only setting where a code is asked for.
 * The fake server knows the users `root` and `alice`; any other user name is a wrong password.
 */
export function totpHarness(
  options: {
    maxPerIdentity?: number
    loginRateLimit?: { max: number; windowMs: number }
    passkeys?: boolean
    /** Whether the database lets the signed-in account manage the other accounts (default yes). */
    manageAccounts?: boolean
  } = {}
) {
  let now = 1_700_000_000_000
  const { lines, logger } = capture()
  const store = new SqliteSessionStore({
    path: ':memory:',
    secret: 's'.repeat(32),
    adapterFactory: (config) => {
      if (config.user !== 'root' && config.user !== 'alice') throw new AdapterError('AUTH_FAILED', 'denied')
      return fixtureAdapter({
        users: ['root', 'alice'].map((name) => ({ name, host: '%', canLogin: true, attributes: [] })),
        manageAccounts: options.manageAccounts ?? true,
      })
    },
    sweepIntervalMs: 0,
    ...(options.maxPerIdentity === undefined ? {} : { maxPerIdentity: options.maxPerIdentity }),
  })
  const app = createApp(
    {
      ...testConfig(),
      ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}),
      // The origin and challenge the recorded passkey answers were made for (see passkey.fixture.json).
      ...(options.passkeys ? { passkey: { origin: PASSKEY_FIXTURE.origin, rpId: PASSKEY_FIXTURE.rpId } } : {}),
    },
    { store, now: () => now, logger, challenge: () => new Uint8Array(32).fill(9) }
  )
  /** One browser: its own cookie. */
  const browser = () => {
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (body: Record<string, unknown> = LOGIN) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie
      return res
    }
    return { req, login }
  }
  /** Signs in, enrols an authenticator app, and returns that browser with the secret. */
  const enrol = async () => {
    const b = browser()
    await b.login()
    const setup = SecondFactorSetupSchema.parse(
      await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()
    )
    const confirmed = await b.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(setup.secret, stepAt(now)) }),
    })
    expect(confirmed.status).toBe(201)
    return { browser: b, code: codeFor(setup.secret, stepAt(now)), secret: setup.secret }
  }
  return { store, lines, browser, enrol, at: () => now, tick: (ms: number) => (now += ms) }
}
