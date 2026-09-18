import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords (RFC 6238) for the second factor: HMAC-SHA1 over a 30-second counter, six
 * digits, as every authenticator app implements it. Written here rather than pulled in as a dependency — it is
 * this much code, and the test checks it against the vectors in the RFC rather than against itself.
 */
export const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6
/** How far out of step a client's clock may be: one step either way, as most implementations allow. */
const TOTP_WINDOW = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding: what authenticator apps read. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret, 20 bytes as RFC 4226 recommends for HMAC-SHA1. */
export function newSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The counter a moment falls in; also what a used code is remembered by, so it cannot be replayed. */
export function stepAt(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS)
}

/** The six digits for one step of one secret. */
export function codeFor(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * The step a code is valid for, or null. `after` is the last step already accepted for this secret: a code is
 * refused at or below it, so one seen by someone else — over a shoulder, in a phishing proxy — cannot be used
 * again within its 30 seconds.
 */
export function verifyCode(secret: string, code: string, atMs: number, after = -1): number | null {
  const given = code.trim()
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(given)) return null
  const now = stepAt(atMs)
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const step = now + offset
    if (step <= after) continue
    if (equal(codeFor(secret, step), given)) return step
  }
  return null
}

/** The URI an authenticator app reads from a QR code or a pasted string. */
export function otpauthUri(secret: string, account: string, issuer = 'tsmyadmin'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** Recovery codes, shown once at enrolment; only their hashes are stored. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => base32Encode(randomBytes(7)).slice(0, 10))
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/\s|-/g, '')).digest('hex')
}

/** Constant-time comparison of two short ASCII strings of the same shape. */
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
