import { type SecondFactorSetup, SecondFactorSetupSchema } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { codeFor, stepAt } from './lib/totp.ts'
import { MAX_MISSES } from './session/second-factor-lock.ts'
import type { SqliteSessionStore } from './session/sqlite-store.ts'
import type { SecondFactor } from './session/store.ts'
import { LOGIN } from './test/app-harness.ts'
import { concurrently, countStatuses, fulfilled, widen } from './test/concurrency-harness.ts'
import { totpHarness } from './test/totp-harness.ts'

/**
 * Invariants of the second factor under bursts of identical requests: a code is spent once, a burst of guesses gets
 * no more looks than the lock allows, and two changes at once never leave one of them silently dropped.
 */
const account = { ...LOGIN, dialect: 'mysql' as const }
/** High enough that the per-user and per-address login limits stay out of the way of the account's own lock. */
const UNLIMITED = { loginRateLimit: { max: 10_000, windowMs: 60_000 } }

const stores: SqliteSessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})

function setup() {
  const h = totpHarness(UNLIMITED)
  stores.push(h.store)
  return h
}

/** Counts the wrong-proof counts that landed: each one is a proof that was then looked at. */
function countLandedMisses(h: ReturnType<typeof setup>) {
  const factors = h.store.secondFactor
  const set = factors.set.bind(factors)
  let landed = 0
  factors.set = async (config, factor: SecondFactor) => {
    const ok = await set(config, factor)
    if (ok && factor.misses !== undefined) landed++
    return ok
  }
  return () => landed
}

describe('the second factor under a burst', () => {
  it('lets one code in once, however many logins carry it at the same moment', async () => {
    const h = setup()
    const { secret } = await h.enrol()
    widen(h.store.secondFactor, ['get', 'set'])
    h.tick(30_000)
    const code = codeFor(secret, stepAt(h.at()))
    const rs = fulfilled(await concurrently(10, () => h.browser().login({ ...LOGIN, code })))
    expect(countStatuses(rs)[201]).toBe(1)
    expect(rs.filter((r) => r.status !== 201).every((r) => r.status === 401)).toBe(true)
  })

  it('spends a recovery code once, however many logins carry it at the same moment', async () => {
    const h = setup()
    const b = h.browser()
    await b.login()
    const started = SecondFactorSetupSchema.parse(
      await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()
    )
    const confirmed = await b.req('/api/second-factor/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: codeFor(started.secret, stepAt(h.at())) }),
    })
    expect(confirmed.status).toBe(201)
    const left = (await h.store.secondFactor.get(account))?.recoveryHashes.length ?? 0
    widen(h.store.secondFactor, ['get', 'set'])
    const code = started.recoveryCodes[0] ?? expect.fail()
    const rs = fulfilled(await concurrently(10, () => h.browser().login({ ...LOGIN, code })))
    expect(countStatuses(rs)[201]).toBe(1)
    expect((await h.store.secondFactor.get(account))?.recoveryHashes).toHaveLength(left - 1)
  })

  it('looks at no more guesses than the lock allows, in waves of guesses sent together', async () => {
    const h = setup()
    const { secret } = await h.enrol()
    const looked = countLandedMisses(h)
    widen(h.store.secondFactor, ['get', 'set'])
    const statuses: number[] = []
    for (let wave = 0; wave < 15; wave++) {
      const rs = fulfilled(await concurrently(8, () => h.browser().login({ ...LOGIN, code: '000000' })))
      statuses.push(...rs.map((r) => r.status))
    }
    expect(looked()).toBeLessThanOrEqual(MAX_MISSES)
    expect(new Set(statuses)).toEqual(new Set([401, 429]))
    expect((await h.store.secondFactor.get(account))?.misses).toBeLessThanOrEqual(MAX_MISSES)
    // Locked: even the right code is not looked at now.
    h.tick(30_000)
    expect((await h.browser().login({ ...LOGIN, code: codeFor(secret, stepAt(h.at())) })).status).toBe(429)
  })

  it('counts the guesses a session sends to change its factor against the same lock', async () => {
    const h = setup()
    const { browser } = await h.enrol()
    const looked = countLandedMisses(h)
    widen(h.store.secondFactor, ['get', 'set'])
    for (let wave = 0; wave < 15; wave++) {
      await concurrently(8, () =>
        browser.req('/api/second-factor', { method: 'DELETE', body: JSON.stringify({ code: '000000' }) })
      )
    }
    expect(looked()).toBeLessThanOrEqual(MAX_MISSES)
    expect(await h.store.secondFactor.get(account)).not.toBeNull()
  })

  it('gives an account one factor when two sessions confirm their first enrolment at the same moment', async () => {
    const h = setup()
    const browsers = [h.browser(), h.browser()]
    const started: SecondFactorSetup[] = []
    for (const b of browsers) {
      await b.login()
      started.push(
        SecondFactorSetupSchema.parse(
          await (await b.req('/api/second-factor/begin', { method: 'POST', body: '{}' })).json()
        )
      )
    }
    // Both read "nothing enrolled" before either writes.
    widen(h.store.secondFactor, ['get'], { together: 2 })
    const rs = await Promise.all(
      browsers.map((b, i) =>
        b.req('/api/second-factor/confirm', {
          method: 'POST',
          body: JSON.stringify({ code: codeFor(started[i]?.secret ?? '', stepAt(h.at())) }),
        })
      )
    )
    // One is enrolled; the other is told to start again, not told it succeeded while its secret was written over.
    expect(countStatuses(rs)).toEqual({ 201: 1, 401: 1 })
    const winner = rs.findIndex((r) => r.status === 201)
    expect((await h.store.secondFactor.get(account))?.secret).toBe(started[winner]?.secret)
  })

  it('keeps a method another tab added while the last one was being removed', async () => {
    const h = setup()
    const { browser, secret } = await h.enrol()
    const factors = h.store.secondFactor
    const clear = factors.clear.bind(factors)
    // Between the removal's read (only the app: nothing left once it goes) and its write, a passkey arrives.
    let interleaved = false
    factors.clear = async (config, version) => {
      if (!interleaved) {
        interleaved = true
        const now = await factors.get(config)
        const passkey = { id: 'added-meanwhile', publicKey: 'pk', counter: 0, at: h.at() }
        expect(now && (await factors.set(config, { ...now, passkeys: [passkey] }))).toBe(true)
      }
      return clear(config, version)
    }
    h.tick(30_000)
    const res = await browser.req('/api/second-factor/totp', {
      method: 'DELETE',
      body: JSON.stringify({ code: codeFor(secret, stepAt(h.at())) }),
    })
    expect(res.status).toBe(200)
    expect(interleaved).toBe(true)
    // The removal read again and found something left: the passkey stays, the app goes.
    const after = await factors.get(account)
    expect(after?.secret).toBeUndefined()
    expect(after?.passkeys?.map((p) => p.id)).toEqual(['added-meanwhile'])
  })
})
