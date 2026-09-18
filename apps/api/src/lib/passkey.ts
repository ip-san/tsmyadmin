import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { StoredPasskey } from '../session/store.ts'

/**
 * Passkeys (WebAuthn) as a second factor, over @simplewebauthn/server: the attestation and assertion formats are
 * CBOR, COSE and ASN.1, which is not code to write again here. These functions only fix the choices this app
 * makes and turn the library's exceptions into "not accepted".
 */

/** The relying party: the origin the browser must report, and the host name the passkey is bound to. */
export interface PasskeyParty {
  origin: string
  rpId: string
}

/** A stored passkey as the library takes a credential descriptor. */
const descriptor = (p: StoredPasskey) => ({ id: p.id, ...(p.transports ? { transports: p.transports } : {}) })

/**
 * Options for adding a passkey. Not discoverable (the database credentials already name the account), no
 * attestation (which authenticator it is does not matter here), and the account's own passkeys are excluded so
 * the same one is not registered twice.
 */
export function registrationOptions(rp: PasskeyParty, account: string, challenge: Uint8Array, have: StoredPasskey[]) {
  return generateRegistrationOptions({
    rpName: 'tsmyadmin',
    rpID: rp.rpId,
    userName: account,
    challenge: new Uint8Array(challenge),
    attestationType: 'none',
    excludeCredentials: have.map(descriptor),
    authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
  })
}

/** The passkey a registration response creates, or null if it does not answer this challenge on this origin. */
export async function verifyRegistration(
  rp: PasskeyParty,
  response: RegistrationResponseJSON,
  challenge: string,
  at: number
): Promise<StoredPasskey | null> {
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: false,
    })
    if (!result.verified) return null
    const { credential } = result.registrationInfo
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      ...(credential.transports?.length ? { transports: credential.transports } : {}),
      at,
    }
  } catch {
    return null
  }
}

/** Options for signing in (or proving the factor) with one of the account's passkeys. */
export function authenticationOptions(rp: PasskeyParty, challenge: Uint8Array, have: StoredPasskey[]) {
  return generateAuthenticationOptions({
    rpID: rp.rpId,
    challenge: new Uint8Array(challenge),
    allowCredentials: have.map(descriptor),
    userVerification: 'preferred',
  })
}

/**
 * Which of the account's passkeys answered, with its new signature counter — or null. The library refuses a
 * counter that did not move forward, except where both are 0 (authenticators that keep none, such as synced
 * passkeys): a cloned authenticator is caught that way where the counter exists at all.
 */
export async function verifyPasskey(
  rp: PasskeyParty,
  response: AuthenticationResponseJSON,
  challenge: string,
  have: StoredPasskey[]
): Promise<{ id: string; counter: number } | null> {
  const passkey = have.find((p) => p.id === response.id)
  if (!passkey) return null
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      credential: {
        ...descriptor(passkey),
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
        counter: passkey.counter,
      },
      requireUserVerification: false,
    })
    return result.verified ? { id: passkey.id, counter: result.authenticationInfo.newCounter } : null
  } catch {
    return null
  }
}
