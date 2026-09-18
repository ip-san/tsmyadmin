import type { PasskeyAnswer, PasskeyChallenge, PasskeyResponse } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'

/**
 * The browser's side of passkeys. The WebAuthn helper is loaded only when a passkey is actually used, so it
 * costs nothing on the pages everyone opens (the login form included).
 */
const browser = () => import('@simplewebauthn/browser')

/**
 * The browser refuses in its own words (a cancelled prompt, a timeout, no matching key): said once, plainly,
 * in the user's language — none of those is something to act on differently.
 */
async function asked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    throw new Error(locale.secondFactor.passkeyFailed)
  }
}

/** Whether this browser can use passkeys at all (it hides the controls where it cannot). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
}

/** Answers a challenge the server handed out with one of the account's passkeys. */
export async function answerChallenge(challenge: PasskeyChallenge): Promise<PasskeyAnswer> {
  const { startAuthentication } = await browser()
  // The options are the server library's own JSON, typed loosely in the shared schema.
  const response = await asked(() => startAuthentication({ optionsJSON: challenge.options as never }))
  return { ticket: challenge.ticket, response: response as unknown as PasskeyAnswer['response'] }
}

/** Creates a passkey for the options a registration started with. */
export async function createPasskey(options: Record<string, unknown>): Promise<PasskeyResponse> {
  const { startRegistration } = await browser()
  const response = await asked(() => startRegistration({ optionsJSON: options as never }))
  return response as unknown as PasskeyResponse
}
