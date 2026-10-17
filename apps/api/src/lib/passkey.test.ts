import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { StoredPasskey } from '../session/store.ts'
import { PASSKEY_FIXTURE } from '../test/app-harness.ts'
import { authenticationOptions, registrationOptions, verifyPasskey, verifyRegistration } from './passkey.ts'

/**
 * The recorded registration and sign-ins (passkey.fixture.json) replayed against the functions directly: what is
 * accepted, and that each thing the browser reports (origin, host name, challenge, counter) is actually checked.
 */
const RP = { origin: PASSKEY_FIXTURE.origin, rpId: PASSKEY_FIXTURE.rpId }
const CHALLENGE_BYTES = new Uint8Array(32).fill(9)
const CHALLENGE = Buffer.from(CHALLENGE_BYTES).toString('base64url')
const AT = 1_700_000_000_000
const registration = PASSKEY_FIXTURE.registration as never
const assertion = (i: number) => PASSKEY_FIXTURE.assertions[i] as never
const ID = String(PASSKEY_FIXTURE.registration.id)

async function registered(): Promise<StoredPasskey> {
  const passkey = await verifyRegistration(RP, registration, CHALLENGE, AT)
  if (!passkey) throw new Error('the recorded registration should verify')
  return passkey
}

describe('verifyRegistration', () => {
  it('turns the recorded registration into a stored passkey with its key, counter, transports and time', async () => {
    const passkey = await registered()
    expect(passkey).toEqual({
      id: ID,
      publicKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      counter: 1,
      transports: ['internal'],
      at: AT,
    })
    // The key is the COSE public key, base64url: long enough to be one, and it round-trips.
    expect(Buffer.from(passkey.publicKey, 'base64url').length).toBeGreaterThan(60)
    expect(Buffer.from(passkey.publicKey, 'base64url').toString('base64url')).toBe(passkey.publicKey)
  })

  it('stores no transports when the browser reported none (or an empty list)', async () => {
    const reg = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
    for (const transports of [undefined, []]) {
      const response = { ...reg, response: { ...reg.response, transports } }
      const passkey = await verifyRegistration(RP, response as never, CHALLENGE, AT)
      expect(passkey).not.toBeNull()
      expect(passkey).not.toHaveProperty('transports')
    }
  })

  it('accepts a key that was only touched, without user verification', async () => {
    // With attestation "none" nothing signs the authenticator data, so the recorded registration can be edited:
    // clear the "user verified" bit in the flags byte that follows the 32-byte hash of the host name.
    const reg = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
    const attestation = Buffer.from(String(reg.response.attestationObject), 'base64url')
    const flags = attestation.indexOf(createHash('sha256').update(RP.rpId).digest()) + 32
    expect(attestation[flags]).toBe(0x45)
    attestation[flags] = 0x41
    const touchOnly = { ...reg, response: { ...reg.response, attestationObject: attestation.toString('base64url') } }
    expect(await verifyRegistration(RP, touchOnly as never, CHALLENGE, AT)).toMatchObject({ id: ID })
  })

  it.each([
    ['another origin', { ...RP, origin: 'http://localhost:3200' }, CHALLENGE],
    ['another host name', { ...RP, rpId: 'example.com' }, CHALLENGE],
    ['another challenge', RP, Buffer.from(new Uint8Array(32).fill(8)).toString('base64url')],
  ])('refuses the registration for %s', async (_label, rp, challenge) => {
    expect(await verifyRegistration(rp, registration, challenge, AT)).toBeNull()
  })

  it('turns a malformed response into null rather than an exception', async () => {
    const reg = PASSKEY_FIXTURE.registration as { response: Record<string, unknown> }
    const broken = { ...reg, response: { ...reg.response, attestationObject: 'AAAA' } }
    await expect(verifyRegistration(RP, broken as never, CHALLENGE, AT)).resolves.toBeNull()
  })
})

describe('verifyPasskey', () => {
  it('accepts a sign-in of the stored passkey and reports its new counter', async () => {
    const passkey = await registered()
    expect(await verifyPasskey(RP, assertion(0), CHALLENGE, [passkey])).toEqual({ id: ID, counter: 2 })
  })

  it('finds the passkey that answered among several', async () => {
    const passkey = await registered()
    const other = { ...passkey, id: 'other-passkey', publicKey: 'AAAA' }
    expect(await verifyPasskey(RP, assertion(1), CHALLENGE, [other, passkey])).toEqual({ id: ID, counter: 3 })
  })

  it('refuses an answer whose counter did not move forward (a replayed or cloned authenticator)', async () => {
    const passkey = await registered()
    // Stored at 3: the sign-ins recorded at 2 and 3 are refused, the one at 4 is accepted.
    const seen = { ...passkey, counter: 3 }
    expect(await verifyPasskey(RP, assertion(0), CHALLENGE, [seen])).toBeNull()
    expect(await verifyPasskey(RP, assertion(1), CHALLENGE, [seen])).toBeNull()
    expect(await verifyPasskey(RP, assertion(2), CHALLENGE, [seen])).toEqual({ id: ID, counter: 4 })
  })

  it('refuses a passkey the account does not have, without asking the library', async () => {
    const passkey = await registered()
    expect(await verifyPasskey(RP, assertion(0), CHALLENGE, [])).toBeNull()
    expect(await verifyPasskey(RP, assertion(0), CHALLENGE, [{ ...passkey, id: 'someone-else' }])).toBeNull()
  })

  it.each([
    ['another origin', { ...RP, origin: 'https://localhost:3199' }, CHALLENGE],
    ['another host name', { ...RP, rpId: 'evil.localhost' }, CHALLENGE],
    ['another challenge', RP, Buffer.from(new Uint8Array(32).fill(1)).toString('base64url')],
  ])('refuses the sign-in for %s', async (_label, rp, challenge) => {
    const passkey = await registered()
    expect(await verifyPasskey(rp, assertion(0), challenge, [passkey])).toBeNull()
  })

  it('refuses a sign-in checked against another public key, and a stored key that is not one', async () => {
    const passkey = await registered()
    const other = await verifyRegistration(RP, registration, CHALLENGE, AT)
    // Same id, different key: flip one byte of the stored key's coordinates.
    const raw = Buffer.from(String(other?.publicKey), 'base64url')
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1
    expect(
      await verifyPasskey(RP, assertion(0), CHALLENGE, [{ ...passkey, publicKey: raw.toString('base64url') }])
    ).toBe(null)
    expect(await verifyPasskey(RP, assertion(0), CHALLENGE, [{ ...passkey, publicKey: 'AAAA' }])).toBeNull()
  })
})

describe('registrationOptions', () => {
  it('asks for a non-discoverable passkey on this host for the account, without attestation', async () => {
    const options = await registrationOptions(RP, 'root@db:3306', CHALLENGE_BYTES, [])
    expect(options).toMatchObject({
      challenge: CHALLENGE,
      rp: { name: 'tsmyadmin', id: 'localhost' },
      user: { name: 'root@db:3306' },
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
    })
  })

  it("excludes the account's own passkeys, with their transports where known", async () => {
    const have: StoredPasskey[] = [
      { id: 'a', publicKey: 'x', counter: 0, transports: ['usb'], at: AT },
      { id: 'b', publicKey: 'x', counter: 0, at: AT },
    ]
    const options = await registrationOptions(RP, 'root@db:3306', CHALLENGE_BYTES, have)
    expect(options.excludeCredentials).toEqual([
      { id: 'a', type: 'public-key', transports: ['usb'] },
      { id: 'b', type: 'public-key' },
    ])
  })
})

describe('authenticationOptions', () => {
  it("allows only the account's passkeys on this host, with the given challenge", async () => {
    const have: StoredPasskey[] = [
      { id: 'a', publicKey: 'x', counter: 0, transports: ['internal'], at: AT },
      { id: 'b', publicKey: 'x', counter: 0, at: AT },
    ]
    const options = await authenticationOptions(RP, CHALLENGE_BYTES, have)
    expect(options).toMatchObject({ rpId: 'localhost', challenge: CHALLENGE, userVerification: 'preferred' })
    expect(options.allowCredentials).toEqual([
      { id: 'a', type: 'public-key', transports: ['internal'] },
      { id: 'b', type: 'public-key' },
    ])
  })
})
