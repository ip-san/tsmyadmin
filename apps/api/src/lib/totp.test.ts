import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  codeFor,
  hashRecoveryCode,
  newRecoveryCodes,
  newSecret,
  otpauthUri,
  stepAt,
  TOTP_STEP_SECONDS,
  verifyCode,
} from './totp.ts'

/** RFC 6238 appendix B uses this ASCII secret for the SHA-1 vectors. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('totp', () => {
  it('produces the codes RFC 6238 lists for its SHA-1 test vectors', () => {
    // seconds → expected code, from the appendix (truncated to the six digits an app shows).
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]
    for (const [seconds, expected] of vectors) {
      expect(codeFor(RFC_SECRET, stepAt(seconds * 1000)), String(seconds)).toBe(expected)
    }
  })

  it('round-trips base32 the way authenticator apps read it', () => {
    expect(base32Encode(Buffer.from('hello!'))).toBe('NBSWY3DPEE')
    expect(base32Decode('NBSWY3DPEE').toString()).toBe('hello!')
    expect(base32Decode('nbswy3dpee').toString()).toBe('hello!')
    expect(() => base32Decode('nope-1')).toThrow()
    expect(base32Decode(newSecret())).toHaveLength(20)
  })

  it('accepts a code one step either side, and nothing else', () => {
    const at = 1_700_000_000_000
    const step = stepAt(at)
    expect(verifyCode(RFC_SECRET, codeFor(RFC_SECRET, step), at)).toBe(step)
    expect(verifyCode(RFC_SECRET, codeFor(RFC_SECRET, step - 1), at)).toBe(step - 1)
    expect(verifyCode(RFC_SECRET, codeFor(RFC_SECRET, step + 1), at)).toBe(step + 1)
    // Two steps away, the wrong number of digits, and anything that is not digits at all.
    expect(verifyCode(RFC_SECRET, codeFor(RFC_SECRET, step + 2), at)).toBeNull()
    expect(verifyCode(RFC_SECRET, '12345', at)).toBeNull()
    expect(verifyCode(RFC_SECRET, '', at)).toBeNull()
    expect(verifyCode(RFC_SECRET, 'abcdef', at)).toBeNull()
  })

  it('refuses a code that was already used, for the rest of its life', () => {
    const at = 1_700_000_000_000
    const step = stepAt(at)
    const code = codeFor(RFC_SECRET, step)
    expect(verifyCode(RFC_SECRET, code, at, step - 1)).toBe(step)
    // Seen by someone else within the same 30 seconds: no longer accepted.
    expect(verifyCode(RFC_SECRET, code, at, step)).toBeNull()
    expect(verifyCode(RFC_SECRET, code, at + TOTP_STEP_SECONDS * 1000, step)).toBeNull()
    // The next step's code still works.
    expect(verifyCode(RFC_SECRET, codeFor(RFC_SECRET, step + 1), at, step)).toBe(step + 1)
  })

  it('writes a URI an app can read, and recovery codes that are stored only as hashes', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'root@db:3306')
    expect(uri).toMatch(/^otpauth:\/\/totp\/tsmyadmin:root%40db%3A3306\?/)
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('digits=6')

    const codes = newRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{10}$/)
    // Written down with spaces or a dash, typed back in lower case: still the same code.
    expect(hashRecoveryCode('abcde-fghij')).toBe(hashRecoveryCode('ABCDE FGHIJ'))
    expect(hashRecoveryCode('abcdefghij')).not.toBe(hashRecoveryCode('abcdefghik'))
  })
})
