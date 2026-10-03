import {
  AccountSecondFactorsSchema,
  ApiErrorSchema,
  PasskeyChallengeSchema,
  PasskeyRegistrationSchema,
  SecondFactorSetupSchema,
  SecondFactorStatusSchema,
  SessionStateSchema,
} from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { type TrustProxy } from './lib/logging.ts'
import { codeFor, stepAt } from './lib/totp.ts'
import { LOCK_MS, MAX_MISSES, withMiss } from './session/second-factor-lock.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { type SecondFactor } from './session/store.ts'
import {
  closeStoresAfterEach,
  fixtureAdapter,
  harness,
  LOGIN,
  PASSKEY_FIXTURE,
  testConfig,
} from './test-support/app-harness.ts'

const stores = closeStoresAfterEach()

describe('second factor', () => {
  /** The same persistent-store harness, with a clock the test can hold still. */
  function totpHarness(
    options: {
      require2fa?: boolean
      maxPerIdentity?: number
      manageAccounts?: boolean
      passkeys?: boolean
      trustProxy?: TrustProxy
    } = {}
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
        ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
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
    const login = async (body: Record<string, unknown> = LOGIN, headers: Record<string, string> = {}) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body), headers })
      const set = res.headers.get('set-cookie')?.split(';')[0]
      if (set) cookie = set
      return res
    }
    /** Another browser: its own cookie, so a second session of the same account that does not close the first. */
    const browser = () => {
      let own = ''
      const request = (path: string, init: RequestInit = {}) =>
        app.request(path, {
          ...init,
          headers: { 'content-type': 'application/json', ...(own ? { cookie: own } : {}), ...(init.headers ?? {}) },
        })
      const signIn = async (body: Record<string, unknown> = LOGIN) => {
        const res = await request('/api/session', { method: 'POST', body: JSON.stringify(body) })
        own = res.headers.get('set-cookie')?.split(';')[0] ?? own
        return res
      }
      return { req: request, login: signIn }
    }
    return { store, req, login, browser, at: () => now, tick: (ms: number) => (now += ms) }
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

  /** A caller on its own address each time, as one with many of them is: no per-address limit is reached. */
  const from = (n: number) => ({ 'x-forwarded-for': `203.0.113.${n}` })
  const WRONG = { ...LOGIN, code: '000000' }

  describe('an enrolment that was started before the account had a second factor, or while it had one', () => {
    const account = { ...LOGIN, dialect: 'mysql' as const }
    const begin = async (b: ReturnType<ReturnType<typeof totpHarness>['browser']>) =>
      SecondFactorSetupSchema.parse(
        await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()
      )
    const confirm = (b: ReturnType<ReturnType<typeof totpHarness>['browser']>, secret: string, at: number) =>
      b.req('/api/second-factor/confirm', {
        method: 'POST',
        body: JSON.stringify({ code: codeFor(secret, stepAt(at)) }),
      })

    it('does not put its secret on a factor another session enrolled meanwhile, which asked for no proof', async () => {
      const h = totpHarness()
      try {
        const a = h.browser()
        await a.login()
        const started = await begin(a)
        // While A holds a half-finished enrolment, the account is enrolled from another session.
        const b = h.browser()
        await b.login()
        const other = await begin(b)
        expect((await confirm(b, other.secret, h.at())).status).toBe(201)

        const late = await confirm(a, started.secret, h.at())
        expect(late.status).toBe(401)
        expect(ApiErrorSchema.parse(await late.json()).code).toBe('SECOND_FACTOR_INVALID')
        // What the account has is still what the proof-giving session set.
        expect((await h.store.secondFactor?.get(account))?.secret).toBe(other.secret)
      } finally {
        await h.store.closeAll()
      }
    })

    it('does not make a factor with no recovery codes when the one it proved itself against was removed meanwhile', async () => {
      const h = totpHarness()
      try {
        const a = h.browser()
        await a.login()
        const first = await begin(a)
        expect((await confirm(a, first.secret, h.at())).status).toBe(201)
        h.tick(30_000)
        // A adds a second app: it proves the first one, and the new secret waits for its confirmation.
        const proof = { code: codeFor(first.secret, stepAt(h.at())) }
        const again = SecondFactorSetupSchema.parse(
          await (await a.req('/api/second-factor/begin', { method: 'POST', body: JSON.stringify(proof) })).json()
        )
        // Meanwhile the account's factor is turned off (from the same account in another session).
        await h.store.secondFactor?.clear(account)
        h.tick(30_000)
        const late = await confirm(a, again.secret, h.at())
        expect(late.status).toBe(401)
        expect(await h.store.secondFactor?.get(account)).toBeNull()
      } finally {
        await h.store.closeAll()
      }
    })
  })

  describe('the lock on wrong codes', () => {
    it('stops after ten wrong codes from any addresses, even for the right one, and opens again after the lock', async () => {
      const h = totpHarness({ trustProxy: 'forwarded' })
      try {
        await h.login()
        const setup = await enrol(h)
        for (let i = 1; i <= MAX_MISSES; i++) {
          const res = await h.login(WRONG, from(i))
          expect(ApiErrorSchema.parse(await res.json()).code).toBe('SECOND_FACTOR_INVALID')
        }
        h.tick(30_000)
        const code = codeFor(setup.secret, stepAt(h.at()))
        const locked = await h.login({ ...LOGIN, code }, from(100))
        expect(locked.status).toBe(429)
        expect(ApiErrorSchema.parse(await locked.json()).code).toBe('RATE_LIMITED')
        // The seconds the lock has left, counted from the last wrong code: a little under the full 15 minutes.
        const wait = Number(locked.headers.get('retry-after'))
        expect(wait).toBeGreaterThan(14 * 60)
        expect(wait).toBeLessThanOrEqual(15 * 60)
        expect(locked.headers.get('set-cookie')).toBeNull()

        h.tick(LOCK_MS)
        const opened = await h.login({ ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) }, from(101))
        expect(opened.status).toBe(201)
      } finally {
        await h.store.closeAll()
      }
    })

    it('forgets the misses once a right code is accepted, so they never add up across logins', async () => {
      const h = totpHarness({ trustProxy: 'forwarded' })
      try {
        await h.login()
        const setup = await enrol(h)
        let n = 0
        for (let round = 0; round < 3; round++) {
          for (let i = 0; i < MAX_MISSES - 1; i++) {
            expect((await h.login(WRONG, from(++n))).status).toBe(401)
          }
          h.tick(30_000)
          const right = { ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) }
          expect((await h.login(right, from(++n))).status).toBe(201)
        }
      } finally {
        await h.store.closeAll()
      }
    })

    it('does not let a burst of guesses see more than the limit allows', async () => {
      const h = totpHarness({ trustProxy: 'forwarded' })
      try {
        await h.login()
        const setup = await enrol(h)
        // One miss short of the lock, then guesses arrive together with the right code among them.
        const account = { ...LOGIN, dialect: 'mysql' as const }
        const read = await h.store.secondFactor?.get(account)
        expect(read).not.toBeNull()
        let counted = read as SecondFactor
        for (let i = 0; i < MAX_MISSES - 1; i++) counted = withMiss(counted, h.at())
        expect(await h.store.secondFactor?.set(account, counted)).toBe(true)

        h.tick(30_000)
        const right = { ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) }
        const burst = await Promise.all(
          Array.from({ length: 8 }, (_, i) => h.login(i === 3 ? right : WRONG, from(i + 1)))
        )
        // The first of them takes the last try; nothing after it is looked at, the right code among them included.
        expect(burst.map((r) => r.status).filter((s) => s === 201)).toEqual([])
        expect((await h.login(right, from(50))).status).toBe(429)
      } finally {
        await h.store.closeAll()
      }
    })

    it('guards the changes made from inside a session the same way', async () => {
      const h = totpHarness({ trustProxy: 'forwarded' })
      try {
        await h.login()
        const setup = await enrol(h)
        for (let i = 1; i <= MAX_MISSES; i++) {
          const res = await h.req('/api/second-factor', {
            method: 'DELETE',
            body: JSON.stringify({ code: '000000' }),
            headers: from(i),
          })
          expect(res.status).toBe(401)
        }
        h.tick(30_000)
        const right = await h.req('/api/second-factor', {
          method: 'DELETE',
          body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
          headers: from(99),
        })
        expect(right.status).toBe(429)
        expect(Number(right.headers.get('retry-after'))).toBeGreaterThan(0)
        // Nothing was removed, and the login is locked as well: it is one account.
        expect(SecondFactorStatusSchema.parse(await (await h.req('/api/second-factor')).json()).state).toBe('enrolled')
        const login = await h.login({ ...LOGIN, code: codeFor(setup.secret, stepAt(h.at())) }, from(98))
        expect(login.status).toBe(429)
      } finally {
        await h.store.closeAll()
      }
    })
  })

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

    it('does not add a passkey to a factor another session enrolled after this one began, which asked for no proof', async () => {
      const h = totpHarness({ passkeys: true })
      try {
        const a = h.browser()
        await a.login()
        const begun = await a.req('/api/second-factor/passkeys/begin', { method: 'POST', body: '{}' })
        expect(begun.status).toBe(200)

        // Meanwhile the account is enrolled with an app from another session.
        const b = h.browser()
        await b.login()
        const setup = SecondFactorSetupSchema.parse(
          await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()
        )
        const enrolled = await b.req('/api/second-factor/confirm', {
          method: 'POST',
          body: JSON.stringify({ code: codeFor(setup.secret, stepAt(h.at())) }),
        })
        expect(enrolled.status).toBe(201)

        const registration = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
        const response = { ...registration, response: { ...registration.response, publicKeyAlgorithm: -7 } }
        const late = await a.req('/api/second-factor/passkeys/confirm', {
          method: 'POST',
          body: JSON.stringify({ response }),
        })
        expect(late.status).toBe(401)
        expect(ApiErrorSchema.parse(await late.json()).code).toBe('SECOND_FACTOR_INVALID')
        expect((await h.store.secondFactor?.get({ ...LOGIN, dialect: 'mysql' as const }))?.passkeys ?? []).toEqual([])
      } finally {
        await h.store.closeAll()
      }
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
