import { describe, expect, it } from 'vitest'
import { IP_LIMIT_FACTOR } from './app.ts'
import { codeFor, stepAt } from './lib/totp.ts'
import { MAX_MISSES } from './session/second-factor-lock.ts'
import { closeStoresAfterEach, eventsOf as events, harness, LOGIN, PASSKEY_FIXTURE } from './test/app-harness.ts'
import { totpHarness } from './test/totp-harness.ts'

/**
 * The second-factor routes' guards, words and log lines, for the cases the main tests do not name: no store that keeps
 * secrets, no passkey origin, the address used up, nothing enrolled, an enrolment that ran out, a locked account, and
 * resetting another account (found as surviving mutants; see `bun run mutation`).
 */

const stores = closeStoresAfterEach()
const error = async (res: Response) => (await res.json()) as { code: string; message: string }
const TEN_MINUTES = 10 * 60_000
const CODE = { code: '123456' }
const PASSKEY_RESPONSE = { response: { id: 'a', rawId: 'a', type: 'public-key', response: {} } }

type Call = [method: string, path: string, body?: unknown]
const send = (req: (path: string, init?: RequestInit) => Response | Promise<Response>, [method, path, body]: Call) =>
  req(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

const TOTP_ROUTES: Call[] = [
  ['POST', '/api/second-factor/begin', {}],
  ['POST', '/api/second-factor/confirm', CODE],
  ['DELETE', '/api/second-factor', CODE],
  ['DELETE', '/api/second-factor/totp', CODE],
  ['DELETE', '/api/second-factor/passkeys/some-id', CODE],
]
const PASSKEY_ROUTES: Call[] = [
  ['POST', '/api/second-factor/passkeys/challenge'],
  ['POST', '/api/second-factor/passkeys/begin', {}],
  ['POST', '/api/second-factor/passkeys/confirm', PASSKEY_RESPONSE],
]

describe('a store that cannot keep secrets', () => {
  it('says so for every route that would need one, in the same words', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const calls: Call[] = [
      ...TOTP_ROUTES,
      ...PASSKEY_ROUTES,
      ['POST', '/api/second-factor/accounts/reset', { user: 'alice' }],
    ]
    for (const call of calls) {
      const res = await send(h.req, call)
      expect(res.status, call.join(' ')).toBe(400)
      expect(await error(res), call.join(' ')).toEqual({
        code: 'UNSUPPORTED',
        message: 'A second factor needs a persistent session store',
      })
    }
  })

  it('lists no accounts to reset', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/second-factor/accounts')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accounts: [] })
  })
})

describe('passkeys without an origin', () => {
  it('say what is missing', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    for (const call of PASSKEY_ROUTES) {
      const res = await send(b.req, call)
      expect(res.status, call.join(' ')).toBe(400)
      expect(await error(res), call.join(' ')).toEqual({
        code: 'UNSUPPORTED',
        message: 'Passkeys need TSMYADMIN_PASSKEY_ORIGIN',
      })
    }
  })
})

describe('an address that has used up its tries', () => {
  it('is turned away from every route that takes a code, with the wait, and does not spend more by asking', async () => {
    const h = totpHarness({ loginRateLimit: { max: 1, windowMs: 60_000 }, passkeys: true })
    stores.push(h.store)
    const b = h.browser()
    expect((await b.login()).status).toBe(201)
    // All but one of the IP_LIMIT_FACTOR failures this address may make (the fake server refuses these user names).
    for (let i = 1; i < IP_LIMIT_FACTOR; i++)
      expect((await h.browser().login({ ...LOGIN, user: `x${i}` })).status).toBe(401)
    // Asking is not a failure: with one try left, asking more times than that still gets an answer, not the wait.
    for (let i = 0; i < 3; i++) {
      expect((await send(b.req, ['DELETE', '/api/second-factor', CODE])).status, `ask ${i}`).toBe(404)
    }
    expect((await h.browser().login({ ...LOGIN, user: 'x0' })).status).toBe(401)
    for (const call of [...TOTP_ROUTES, ...PASSKEY_ROUTES]) {
      const res = await send(b.req, call)
      expect(res.status, call.join(' ')).toBe(429)
      expect(res.headers.get('retry-after'), call.join(' ')).toBe('60')
      expect(await error(res), call.join(' ')).toEqual({
        code: 'RATE_LIMITED',
        message: 'Too many code attempts; try again later',
      })
    }
  })
})

describe('nothing enrolled', () => {
  it('turns off nothing, removes no app and no passkey, and has no challenge to give', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const cases: [Call, string][] = [
      [['DELETE', '/api/second-factor', CODE], 'Nothing is enrolled for this account'],
      [['DELETE', '/api/second-factor/totp', CODE], 'No authenticator app is enrolled'],
      [['POST', '/api/second-factor/passkeys/challenge'], 'No passkey is enrolled'],
      [['DELETE', '/api/second-factor/passkeys/some-id', CODE], 'No such passkey'],
    ]
    for (const [call, message] of cases) {
      const res = await send(b.req, call)
      expect(res.status, call.join(' ')).toBe(404)
      expect(await error(res), call.join(' ')).toEqual({ code: 'NOT_FOUND', message })
    }
  })

  it('has no passkey to remove, and no challenge to give, when only an app is enrolled', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const { browser } = await h.enrol()
    const res = await send(browser.req, ['DELETE', '/api/second-factor/passkeys/some-id', CODE])
    expect(res.status).toBe(404)
    expect((await error(res)).message).toBe('No such passkey')
    const none = await send(browser.req, ['POST', '/api/second-factor/passkeys/challenge'])
    expect(none.status).toBe(404)
  })
})

describe('enrolling an authenticator app', () => {
  it('hands out a link for the app that names the account, and the codes to write down', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const res = await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { secret: string; uri: string; recoveryCodes: string[]; qr: unknown }
    expect(body.uri).toContain('otpauth://totp/tsmyadmin:root%40db%3A3306?')
    expect(body.uri).toContain(`secret=${body.secret}`)
    expect(body.recoveryCodes.length).toBeGreaterThan(0)
    expect(body.qr).toBeTruthy()
  })

  it('asks to start again when nothing was started, or when it was started more than ten minutes ago', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const none = await b.req('/api/second-factor/confirm', { method: 'POST', body: JSON.stringify(CODE) })
    expect(none.status).toBe(401)
    expect(await error(none)).toEqual({ code: 'SECOND_FACTOR_INVALID', message: 'Start the enrolment again' })

    const begin = async () =>
      ((await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()) as { secret: string })
        .secret
    // Exactly ten minutes later it still counts; a moment later it does not.
    let secret = await begin()
    h.tick(TEN_MINUTES)
    const onTime = await b.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(onTime.status).toBe(201)

    const other = h.browser()
    await other.login({ ...LOGIN, user: 'alice' })
    secret = (
      (await (await other.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()) as {
        secret: string
      }
    ).secret
    h.tick(TEN_MINUTES + 1)
    const late = await other.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(late.status).toBe(401)
    expect((await error(late)).message).toBe('Start the enrolment again')
    // The attempt is gone: even the right code now has nothing to confirm.
    const again = await other.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(again.status).toBe(401)
  })

  it('refuses a wrong code, says so, and writes a line for it; a right one writes the line for the enrolment', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const { secret } = (await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()) as {
      secret: string
    }
    const wrong = await b.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: '000000' }),
    })
    expect(wrong.status).toBe(401)
    expect(await error(wrong)).toEqual({ code: 'SECOND_FACTOR_INVALID', message: 'That code is not valid' })
    expect(events(h.lines, 'second_factor.confirm.failed')).toMatchObject([
      { level: 'warn', requestId: expect.any(String), user: 'root', host: 'db', port: 3306, dialect: 'mysql' },
    ])
    expect(events(h.lines, 'second_factor.enrolled')).toEqual([])
    const right = await b.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(right.status).toBe(201)
    expect(await right.json()).toMatchObject({ state: 'enrolled', totp: true })
    expect(events(h.lines, 'second_factor.enrolled')).toMatchObject([
      { level: 'info', requestId: expect.any(String), user: 'root' },
    ])
    expect(JSON.stringify(h.lines)).not.toContain(secret)
  })
})

describe('changing what is enrolled needs proof', () => {
  it('starting again without a proof is refused and written down', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const { browser } = await h.enrol()
    const res = await browser.req('/api/second-factor/begin', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect((await error(res)).code).toBe('SECOND_FACTOR_INVALID')
    expect(events(h.lines, 'second_factor.reenrol.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
  })

  it('turning it off with a wrong code is refused and written down; with the right one it is turned off and written down', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    const wrong = await browser.req('/api/second-factor', {
      method: 'DELETE',
      body: JSON.stringify({ code: '000000' }),
    })
    expect(wrong.status).toBe(401)
    expect(await error(wrong)).toEqual({ code: 'SECOND_FACTOR_INVALID', message: 'That code is not valid' })
    expect(events(h.lines, 'second_factor.disable.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
    h.tick(30_000)
    const right = await browser.req('/api/second-factor', {
      method: 'DELETE',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(right.status).toBe(200)
    expect(await right.json()).toMatchObject({ state: 'none', totp: false, recoveryCodesLeft: 0 })
    expect(events(h.lines, 'second_factor.disabled')).toMatchObject([{ level: 'info', user: 'root' }])
    expect(events(h.lines, 'second_factor.disable.failed')).toHaveLength(1)
  })

  it('removing the app of an account that has no other way in turns the factor off, and says it in a line', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    h.tick(30_000)
    const res = await browser.req('/api/second-factor/totp', {
      method: 'DELETE',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: 'none', totp: false, passkeys: [] })
    expect(events(h.lines, 'second_factor.totp_removed')).toMatchObject([{ level: 'info', user: 'root' }])
  })

  it('a refused removal of the app is written down under its own name', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const { browser } = await h.enrol()
    const res = await browser.req('/api/second-factor/totp', {
      method: 'DELETE',
      body: JSON.stringify({ code: '000000' }),
    })
    expect(res.status).toBe(401)
    expect(events(h.lines, 'second_factor.totp_remove.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
  })

  it('a locked account answers with the wait, and the line says which attempt it was', async () => {
    const h = totpHarness({ loginRateLimit: { max: 100, windowMs: 60_000 } })
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    for (let i = 0; i < MAX_MISSES; i++) {
      await browser.req('/api/second-factor', { method: 'DELETE', body: JSON.stringify({ code: '000000' }) })
    }
    h.tick(30_000)
    const res = await browser.req('/api/second-factor', {
      method: 'DELETE',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(res.status).toBe(429)
    // The lock is 15 minutes from the last miss, and the clock moved 30 seconds since.
    expect(res.headers.get('retry-after')).toBe('870')
    expect(await error(res)).toEqual({ code: 'RATE_LIMITED', message: 'Too many code attempts; try again later' })
    expect(events(h.lines, 'second_factor.locked')).toMatchObject([
      { level: 'warn', requestId: expect.any(String), user: 'root', attempt: 'second_factor.disable.failed' },
    ])
  })
})

describe('resetting another account', () => {
  it('lists the accounts that have a second factor and that this one may manage, not itself', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const root = await h.enrol()
    const alice = h.browser()
    await alice.login({ ...LOGIN, user: 'alice' })
    expect(await (await root.browser.req('/api/second-factor/accounts')).json()).toEqual({ accounts: [] })
    // alice enrols herself.
    const setup = (await (await alice.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()) as {
      secret: string
    }
    h.tick(30_000)
    await alice.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
    })
    expect(await (await root.browser.req('/api/second-factor/accounts')).json()).toEqual({ accounts: ['alice'] })
    expect(await (await alice.req('/api/second-factor/accounts')).json()).toEqual({ accounts: ['root'] })

    const res = await root.browser.req('/api/second-factor/accounts/reset', {
      method: 'POST',
      body: JSON.stringify({ user: 'alice' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accounts: [] })
    expect(events(h.lines, 'second_factor.reset')).toMatchObject([
      { level: 'warn', requestId: expect.any(String), user: 'root', target: 'alice' },
    ])
  })

  it('refuses to reset its own, one it may not manage, and one with nothing enrolled, each in its own words', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const reset = (user: string) =>
      b.req('/api/second-factor/accounts/reset', { method: 'POST', body: JSON.stringify({ user }) })
    const own = await reset('root')
    expect(own.status).toBe(403)
    expect(await error(own)).toEqual({
      code: 'FORBIDDEN',
      message: 'Remove your own second factor from the security tab',
    })
    const empty = await reset('alice')
    expect(empty.status).toBe(404)
    expect(await error(empty)).toEqual({ code: 'NOT_FOUND', message: 'Nothing is enrolled for that account' })
    expect(events(h.lines, 'second_factor.reset')).toEqual([])
    const limited = totpHarness({ manageAccounts: false })
    stores.push(limited.store)
    const c = limited.browser()
    await c.login()
    const res = await c.req('/api/second-factor/accounts/reset', {
      method: 'POST',
      body: JSON.stringify({ user: 'alice' }),
    })
    expect(res.status).toBe(403)
    expect(await error(res)).toEqual({ code: 'FORBIDDEN', message: 'This account cannot manage that one' })
  })
})

describe('passkeys: adding and removing', () => {
  const registration = () => {
    const recorded = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
    // As @simplewebauthn/browser sends it: with the new key's COSE algorithm as a number (-7, ES256).
    return { ...recorded, response: { ...recorded.response, publicKeyAlgorithm: -7 } }
  }
  const begin = (b: { req: (path: string, init?: RequestInit) => Response | Promise<Response> }, proof: unknown = {}) =>
    b.req('/api/second-factor/passkeys/begin', { method: 'POST', body: JSON.stringify(proof) })
  const confirm = (
    b: { req: (path: string, init?: RequestInit) => Response | Promise<Response> },
    response: unknown = registration()
  ) => b.req('/api/second-factor/passkeys/confirm', { method: 'POST', body: JSON.stringify({ response }) })
  const passkeyId = String(PASSKEY_FIXTURE.assertions[0]?.id)

  it('adds the recorded passkey to an account with nothing, with recovery codes, and writes a line for it', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const begun = await begin(b)
    expect(begun.status).toBe(200)
    const { recoveryCodes, options } = (await begun.json()) as {
      recoveryCodes: string[]
      options: { challenge: string }
    }
    expect(recoveryCodes.length).toBeGreaterThan(0)
    expect(options.challenge).toBeTruthy()
    const done = await confirm(b)
    expect(done.status).toBe(201)
    const status = (await done.json()) as { state: string; passkeys: { id: string }[]; recoveryCodesLeft: number }
    expect(status.state).toBe('enrolled')
    expect(status.passkeys.map((p) => p.id)).toEqual([passkeyId])
    expect(status.recoveryCodesLeft).toBe(recoveryCodes.length)
    expect(events(h.lines, 'second_factor.passkey_added')).toMatchObject([
      { level: 'info', requestId: expect.any(String), user: 'root' },
    ])
  })

  it('asks to start again when nothing was started or it was started more than ten minutes ago, and forgets what was started', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    const none = await confirm(b)
    expect(none.status).toBe(401)
    expect(await error(none)).toEqual({ code: 'SECOND_FACTOR_INVALID', message: 'Start adding the passkey again' })
    await begin(b)
    h.tick(TEN_MINUTES + 1)
    const late = await confirm(b)
    expect(late.status).toBe(401)
    expect((await error(late)).message).toBe('Start adding the passkey again')
    // Taken out whether or not it was good: starting again is needed.
    expect((await confirm(b)).status).toBe(401)
    // Exactly ten minutes still counts.
    await begin(b)
    h.tick(TEN_MINUTES)
    expect((await confirm(b)).status).toBe(201)
  })

  it('refuses an answer that does not fit, with the words for a wrong code, and writes a line for it', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const b = h.browser()
    await b.login()
    await begin(b)
    const res = await confirm(b, PASSKEY_FIXTURE.assertions[0])
    expect(res.status).toBe(401)
    expect(await error(res)).toEqual({ code: 'SECOND_FACTOR_INVALID', message: 'That code is not valid' })
    expect(events(h.lines, 'second_factor.passkey_add.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
  })

  it('asks an account that has an app for its code before adding a passkey, and then keeps its recovery codes', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    const refused = await begin(browser)
    expect(refused.status).toBe(401)
    expect(events(h.lines, 'second_factor.passkey_add.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
    h.tick(30_000)
    const begun = await begin(browser, { code: codeFor(secret, stepAt(h.at())) })
    expect(begun.status).toBe(200)
    expect(((await begun.json()) as { recoveryCodes: string[] }).recoveryCodes).toEqual([])
    const done = await confirm(browser)
    expect(done.status).toBe(201)
    expect(await done.json()).toMatchObject({ totp: true, passkeys: [{ id: passkeyId }] })
  })

  it('removes a passkey with proof, keeps the app, and says "no such passkey" for any other id', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    h.tick(30_000)
    await begin(browser, { code: codeFor(secret, stepAt(h.at())) })
    expect((await confirm(browser)).status).toBe(201)
    const remove = (id: string, body: unknown) =>
      browser.req(`/api/second-factor/passkeys/${id}`, { method: 'DELETE', body: JSON.stringify(body) })
    const unknown = await remove('another-id', CODE)
    expect(unknown.status).toBe(404)
    expect(await error(unknown)).toEqual({ code: 'NOT_FOUND', message: 'No such passkey' })
    const wrong = await remove(passkeyId, { code: '000000' })
    expect(wrong.status).toBe(401)
    expect(events(h.lines, 'second_factor.passkey_remove.failed')).toMatchObject([{ level: 'warn', user: 'root' }])
    h.tick(30_000)
    const done = await remove(passkeyId, { code: codeFor(secret, stepAt(h.at())) })
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ state: 'enrolled', totp: true, passkeys: [] })
    expect(events(h.lines, 'second_factor.passkey_removed')).toMatchObject([{ level: 'info', user: 'root' }])
  })

  it('removing the app leaves the passkey, and the account stays enrolled', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    h.tick(30_000)
    await begin(browser, { code: codeFor(secret, stepAt(h.at())) })
    await confirm(browser)
    h.tick(30_000)
    const res = await browser.req('/api/second-factor/totp', {
      method: 'DELETE',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: 'enrolled', totp: false, passkeys: [{ id: passkeyId }] })
    // With the passkey alone left, there is no app to remove any more.
    const again = await send(browser.req, ['DELETE', '/api/second-factor/totp', CODE])
    expect(again.status).toBe(404)
    expect(await error(again)).toEqual({ code: 'NOT_FOUND', message: 'No authenticator app is enrolled' })
  })

  it('offers passkeys only where there is an origin and a store that keeps them', async () => {
    const withOrigin = totpHarness({ passkeys: true })
    const without = totpHarness()
    stores.push(withOrigin.store)
    stores.push(without.store)
    const a = withOrigin.browser()
    await a.login()
    expect(await (await a.req('/api/second-factor')).json()).toMatchObject({ passkeysAvailable: true })
    const b = without.browser()
    await b.login()
    expect(await (await b.req('/api/second-factor')).json()).toMatchObject({ passkeysAvailable: false })
  })
})
