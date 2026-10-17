import { ApiErrorSchema, PasskeyChallengeSchema, SecondFactorStatusSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { codeFor, stepAt } from './lib/totp.ts'
import { MAX_MISSES } from './session/second-factor-lock.ts'
import { closeStoresAfterEach, LOGIN, PASSKEY_FIXTURE } from './test/app-harness.ts'
import { totpHarness } from './test/totp-harness.ts'

/**
 * Edges of the second-factor routes that the main tests pass over (found as surviving mutants; see `bun run
 * mutation`): how long a passkey challenge stays answerable and that other challenges are left alone, that each
 * enrolment is confirmed once, that refusals spend the address's budget, and accounts with more than one passkey.
 */

const stores = closeStoresAfterEach()
const TWO_MINUTES = 2 * 60_000
const ACCOUNT = { ...LOGIN, dialect: 'mysql' as const }
const PASSKEY_ID = String(PASSKEY_FIXTURE.registration.id)
const assertion = (n: number) => PASSKEY_FIXTURE.assertions[n] as Record<string, unknown>
type Browser = { req: (path: string, init?: RequestInit) => Response | Promise<Response> }
const post = (b: Browser, path: string, body: unknown = {}) =>
  b.req(path, { method: 'POST', body: JSON.stringify(body) })
const registration = () => {
  const recorded = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
  return { ...recorded, response: { ...recorded.response, publicKeyAlgorithm: -7 } }
}

/** A harness with passkeys whose account `root` has the recorded passkey (and recovery codes) and nothing else. */
async function withPasskey() {
  const h = totpHarness({ passkeys: true })
  stores.push(h.store)
  const b = h.browser()
  await b.login()
  // A second session of the same account, signed in while it still needed no second factor.
  const other = h.browser()
  await other.login()
  expect((await post(b, '/api/second-factor/passkeys/begin')).status).toBe(200)
  expect((await post(b, '/api/second-factor/passkeys/confirm', { response: registration() })).status).toBe(201)
  return { h, b, other }
}

const challenge = async (b: Browser) =>
  PasskeyChallengeSchema.parse(await (await post(b, '/api/second-factor/passkeys/challenge')).json()).ticket
const proofWith = (ticket: string, n: number) => ({ passkey: { ticket, response: assertion(n) } })

describe('passkey challenges', () => {
  it('stay answerable for exactly two minutes, and asking for one leaves the other sessions’ challenges alone', async () => {
    const { h, b, other } = await withPasskey()
    const ticket = await challenge(b)
    h.tick(TWO_MINUTES)
    // Another session of the same account asks for its own at the very end of the first one's window: that neither
    // replaces the first (it is bound to another session) nor sweeps it away (it has not run out yet).
    await challenge(other)
    const onTime = await post(b, '/api/second-factor/begin', proofWith(ticket, 0))
    expect(onTime.status).toBe(200)

    const late = await challenge(b)
    h.tick(TWO_MINUTES + 1)
    const refused = await post(b, '/api/second-factor/begin', proofWith(late, 1))
    expect(refused.status).toBe(401)
    expect(ApiErrorSchema.parse(await refused.json()).code).toBe('SECOND_FACTOR_INVALID')
    // The answer itself was good: with a fresh challenge it is accepted.
    expect((await post(b, '/api/second-factor/begin', proofWith(await challenge(b), 1))).status).toBe(200)
  })

  it('are not given at login to an account whose only method is an app, even where passkeys are offered', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    await h.enrol()
    const res = await h.browser().login()
    expect(res.status).toBe(401)
    const body = ApiErrorSchema.parse(await res.json())
    expect(body.code).toBe('SECOND_FACTOR_REQUIRED')
    expect(body.passkey).toBeUndefined()
  })
})

describe('an account with two passkeys', () => {
  async function twoPasskeys() {
    const setup = await withPasskey()
    const store = setup.h.store.secondFactor
    if (!store) throw new Error('no store')
    const factor = await store.get(ACCOUNT)
    if (!factor?.passkeys) throw new Error('not enrolled')
    const other = { id: 'other-key', publicKey: 'AA', counter: 7, at: setup.h.at() }
    expect(await store.set(ACCOUNT, { ...factor, passkeys: [...factor.passkeys, other] })).toBe(true)
    return { ...setup, store }
  }

  it('moves on the counter of the passkey that signed in, and only that one', async () => {
    const { h, store } = await twoPasskeys()
    const fresh = h.browser()
    const asked = ApiErrorSchema.parse(await (await fresh.login()).json())
    const ticket = asked.passkey?.ticket ?? ''
    expect((await fresh.login({ ...LOGIN, passkey: { ticket, response: assertion(0) } })).status).toBe(201)
    expect((await store.get(ACCOUNT))?.passkeys?.map((p) => [p.id, p.counter])).toEqual([
      [PASSKEY_ID, 2],
      ['other-key', 7],
    ])
  })

  it('removes the one named and keeps the other (and the account stays enrolled)', async () => {
    const { b, store } = await twoPasskeys()
    const res = await b.req('/api/second-factor/passkeys/other-key', {
      method: 'DELETE',
      body: JSON.stringify(proofWith(await challenge(b), 0)),
    })
    expect(res.status).toBe(200)
    const status = SecondFactorStatusSchema.parse(await res.json())
    expect(status.state).toBe('enrolled')
    expect(status.passkeys.map((p) => p.id)).toEqual([PASSKEY_ID])
    expect((await store.get(ACCOUNT))?.passkeys?.map((p) => p.id)).toEqual([PASSKEY_ID])
  })
})

describe('an enrolment is confirmed once', () => {
  it('an app added to an account that has one: the same code cannot confirm it twice', async () => {
    const h = totpHarness()
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    h.tick(30_000)
    const begun = await post(browser, '/api/second-factor/begin', { code: codeFor(secret, stepAt(h.at())) })
    expect(begun.status).toBe(200)
    const next = ((await begun.json()) as { secret: string }).secret
    h.tick(30_000)
    const code = { code: codeFor(next, stepAt(h.at())) }
    expect((await post(browser, '/api/second-factor/confirm', code)).status).toBe(201)
    const again = await post(browser, '/api/second-factor/confirm', code)
    expect(again.status).toBe(401)
    expect(ApiErrorSchema.parse(await again.json()).message).toBe('Start the enrolment again')
  })

  it('a passkey added to an account that has an app: the same answer cannot add it twice', async () => {
    const h = totpHarness({ passkeys: true })
    stores.push(h.store)
    const { browser, secret } = await h.enrol()
    h.tick(30_000)
    const begun = await post(browser, '/api/second-factor/passkeys/begin', { code: codeFor(secret, stepAt(h.at())) })
    expect(begun.status).toBe(200)
    // The passkey is named after the account and the server it signs in to.
    expect(((await begun.json()) as { options: { user: { name: string } } }).options.user.name).toBe('root@db:3306')
    expect((await post(browser, '/api/second-factor/passkeys/confirm', { response: registration() })).status).toBe(201)
    const again = await post(browser, '/api/second-factor/passkeys/confirm', { response: registration() })
    expect(again.status).toBe(401)
    expect(ApiErrorSchema.parse(await again.json()).message).toBe('Start adding the passkey again')
    expect((await h.store.secondFactor?.get(ACCOUNT))?.passkeys?.map((p) => p.id)).toEqual([PASSKEY_ID])
  })
})

describe('refusals spend the address’s budget', () => {
  it('wrong codes and knocks on a locked account both count, until the address itself is turned away', async () => {
    // max 4 → 12 failures per address (IP_LIMIT_FACTOR 3): the account locks after 10, the address after 12.
    const h = totpHarness({ loginRateLimit: { max: 4, windowMs: 60_000 } })
    stores.push(h.store)
    const { browser } = await h.enrol()
    const wrong = () =>
      browser.req('/api/second-factor', { method: 'DELETE', body: JSON.stringify({ code: '000000' }) })
    for (let i = 0; i < MAX_MISSES; i++) expect((await wrong()).status, `miss ${i}`).toBe(401)
    // Locked: the wait is the account's (15 minutes).
    for (let i = 0; i < 2; i++) {
      const locked = await wrong()
      expect(locked.status).toBe(429)
      expect(locked.headers.get('retry-after')).toBe('900')
    }
    // Twelve failures from this address: now it is the address's own window (a minute) that answers.
    const turnedAway = await wrong()
    expect(turnedAway.status).toBe(429)
    expect(turnedAway.headers.get('retry-after')).toBe('60')
  })
})
