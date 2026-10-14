import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  entriesWithoutPort,
  invalidEntries,
  isHostAllowed,
  normaliseHost,
  parseEntry,
  presetEntry,
} from './allowlist.ts'
import { RateLimiter } from './rate-limit.ts'
import { base32Decode, base32Encode, codeFor, hashRecoveryCode, otpauthUri, stepAt, verifyCode } from './totp.ts'

/**
 * The edges of the three guards in front of a login: which hosts may be reached, how often one may try, and what a
 * one-time code is. Each is a boundary an attacker leans on, so each is pinned here (found as surviving mutants; see
 * `bun run mutation`).
 */

describe('isHostAllowed', () => {
  it('lets a host through on an exact entry, in any case, with or without a trailing dot or brackets', () => {
    expect(isHostAllowed('db.internal', 5432, ['db.internal'])).toBe(true)
    expect(isHostAllowed('DB.Internal.', 5432, ['db.internal'])).toBe(true)
    expect(isHostAllowed('db.internal', 5432, ['DB.INTERNAL'])).toBe(true)
    expect(isHostAllowed('::1', 3306, ['[::1]'])).toBe(true)
    expect(isHostAllowed('[::1]', 3306, ['::1'])).toBe(true)
    expect(isHostAllowed('db.internal', 5432, ['other', 'db.internal'])).toBe(true)
    expect(isHostAllowed('db.internal', 5432, [])).toBe(false)
    expect(isHostAllowed('', 5432, ['*'])).toBe(false)
    expect(isHostAllowed('  ', 5432, ['*'])).toBe(false)
    expect(isHostAllowed('.', 5432, ['*'])).toBe(false)
  })

  it('does not take a host that only ends in, or contains, an entry for the entry', () => {
    expect(isHostAllowed('xdb.internal', 5432, ['db.internal'])).toBe(false)
    expect(isHostAllowed('db.internal.evil.com', 5432, ['db.internal'])).toBe(false)
    expect(isHostAllowed('b.internal', 5432, ['db.internal'])).toBe(false)
    expect(isHostAllowed('xb.internal', 5432, ['db.internal'])).toBe(false)
  })

  it('allows every host with *, and a subdomain with *.suffix but not the suffix itself', () => {
    expect(isHostAllowed('anything', 1, ['*'])).toBe(true)
    expect(isHostAllowed('a.example.com', 5432, ['*.example.com'])).toBe(true)
    expect(isHostAllowed('a.b.example.com', 5432, ['*.example.com'])).toBe(true)
    expect(isHostAllowed('example.com', 5432, ['*.example.com'])).toBe(false)
    expect(isHostAllowed('.example.com', 5432, ['*.example.com'])).toBe(false)
    expect(isHostAllowed('xexample.com', 5432, ['*.example.com'])).toBe(false)
    expect(isHostAllowed('a.example.com.evil', 5432, ['*.example.com'])).toBe(false)
  })

  it('holds the port when the entry names one, and allows every port when it does not', () => {
    expect(isHostAllowed('db', 5432, ['db:5432'])).toBe(true)
    expect(isHostAllowed('db', 5433, ['db:5432'])).toBe(false)
    expect(isHostAllowed('db', 1, ['db'])).toBe(true)
    expect(isHostAllowed('db', 65535, ['db'])).toBe(true)
    expect(isHostAllowed('x.rds.com', 5432, ['*.rds.com:5432'])).toBe(true)
    expect(isHostAllowed('x.rds.com', 3306, ['*.rds.com:5432'])).toBe(false)
    expect(isHostAllowed('::1', 3306, ['[::1]:3306'])).toBe(true)
    expect(isHostAllowed('::1', 3307, ['[::1]:3306'])).toBe(false)
    expect(isHostAllowed('anything', 5432, ['*:5432'])).toBe(true)
    expect(isHostAllowed('anything', 5433, ['*:5432'])).toBe(false)
  })
})

describe('allowlist entries', () => {
  it('reads host and port from an entry, trimmed, and takes a port outside 1…65535 for part of the name', () => {
    expect(parseEntry('db:5432')).toEqual({ host: 'db', port: 5432 })
    expect(parseEntry('  DB.Internal.:5432 ')).toEqual({ host: 'db.internal', port: 5432 })
    expect(parseEntry('[::1]:3306')).toEqual({ host: '::1', port: 3306 })
    expect(parseEntry('db')).toEqual({ host: 'db', port: null })
    expect(parseEntry('  db  ')).toEqual({ host: 'db', port: null })
    expect(parseEntry('db:1')).toEqual({ host: 'db', port: 1 })
    expect(parseEntry('db:65535')).toEqual({ host: 'db', port: 65535 })
    expect(parseEntry('db:0')).toEqual({ host: 'db:0', port: null })
    expect(parseEntry('db:65536')).toEqual({ host: 'db:65536', port: null })
    expect(parseEntry('db:123456')).toEqual({ host: 'db:123456', port: null })
    // The pattern covers the whole entry: a port after more colons, or text after the digits, is no port.
    expect(parseEntry('x:y:5432')).toEqual({ host: 'x:y:5432', port: null })
    expect(parseEntry('db:5432x')).toEqual({ host: 'db:5432x', port: null })
    expect(parseEntry('::1:5432')).toEqual({ host: '::1:5432', port: null })
  })

  it('names the entries that can never match a login target, and none of the good ones', () => {
    const bad = ['db:abc', 'db:5432:x', '::1:5432', ':5432', 'db:', 'db:0', 'db:65536', 'db:99999', ' db:abc ']
    expect(invalidEntries(bad)).toEqual(bad)
    const good = ['db', 'db:1', 'db:65535', 'db:5432', '[::1]', '[::1]:5432', '*', '*.example.com:5432', ' db ', '']
    expect(invalidEntries(good)).toEqual([])
    expect(invalidEntries(['ok', 'bad:x', 'ok:1'])).toEqual(['bad:x'])
  })

  it('names the entries that allow every port', () => {
    expect(entriesWithoutPort(['db', 'db:5432', '[::1]', '[::1]:1', '*', ' x '])).toEqual(['db', '[::1]', '*', ' x '])
    expect(entriesWithoutPort([])).toEqual([])
  })

  it('writes the entry of a preset with its port, an IPv6 literal bracketed', () => {
    expect(presetEntry({ host: 'db.internal', port: 5432 })).toBe('db.internal:5432')
    expect(presetEntry({ host: '::1', port: 3306 })).toBe('[::1]:3306')
  })

  it('normalises a host the way the check compares it, so the connection uses the same string', () => {
    expect(normaliseHost(' EXAMPLE.com. ')).toBe('example.com')
    expect(normaliseHost('[::1]')).toBe('::1')
    expect(normaliseHost('[2001:DB8::1]')).toBe('2001:db8::1')
    expect(normaliseHost('[::1')).toBe('[::1')
    expect(normaliseHost('::1]')).toBe('::1]')
    expect(normaliseHost('a[b]')).toBe('a[b]')
    expect(normaliseHost('[b]c')).toBe('[b]c')
    expect(normaliseHost('127.0.0.1..')).toBe('127.0.0.1.')
  })
})

describe('RateLimiter', () => {
  const make = (max = 3, windowMs = 10_000) => {
    let t = 1_000
    const limiter = new RateLimiter(max, windowMs, () => t, 3_600_000)
    return { limiter, at: (ms: number) => (t = ms), advance: (ms: number) => (t += ms) }
  }
  /**
   * How many keys the limiter holds: the map is private, and a swept key answers `peek` the same as one whose window
   * merely ended, so the sweep can only be seen from the inside.
   */
  const held = (limiter: RateLimiter) => (limiter as unknown as { windows: Map<string, unknown> }).windows.size
  afterEach(() => vi.restoreAllMocks())

  it('counts attempts per key, allowing max and refusing the next, with what is left and when to retry', () => {
    const { limiter, advance } = make(3, 10_000)
    expect(limiter.hit('a')).toEqual({ allowed: true, remaining: 2, retryAfterSec: 10, windowEnd: 11_000 })
    advance(2_500)
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 1, retryAfterSec: 8, windowEnd: 11_000 })
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 0 })
    expect(limiter.hit('a')).toMatchObject({ allowed: false, remaining: 0 })
    expect(limiter.hit('a')).toMatchObject({ allowed: false, remaining: 0 })
    expect(limiter.hit('b')).toMatchObject({ allowed: true, remaining: 2 })
    limiter.stop()
  })

  it('starts a window of its own when the last one ends, at its very end', () => {
    const { limiter, at } = make(1, 10_000)
    limiter.hit('a')
    expect(limiter.hit('a').allowed).toBe(false)
    at(10_999)
    expect(limiter.hit('a').allowed).toBe(false)
    at(11_000)
    expect(limiter.hit('a')).toMatchObject({ allowed: true, windowEnd: 21_000 })
    limiter.stop()
  })

  it('takes an attempt back while its window is the current one, and never below none', () => {
    const { limiter, at } = make(2, 10_000)
    const first = limiter.hit('a')
    limiter.hit('a')
    limiter.refund('a', first.windowEnd)
    expect(limiter.peek('a').allowed).toBe(true)
    limiter.refund('a', first.windowEnd)
    limiter.refund('a', first.windowEnd)
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 1 })
    // Another window's end, an unknown key, and a window that has since ended refund nothing.
    limiter.refund('a', first.windowEnd + 1)
    limiter.refund('nobody', first.windowEnd)
    expect(limiter.hit('a')).toMatchObject({ remaining: 0 })
    at(20_000)
    limiter.hit('a')
    limiter.refund('a', first.windowEnd)
    expect(limiter.hit('a')).toMatchObject({ remaining: 0 })
    limiter.stop()
  })

  it('reports a key without counting it: free with no window, blocked at the limit, free again when the window ends', () => {
    const { limiter, at } = make(2, 10_000)
    expect(limiter.peek('a')).toEqual({ allowed: true, retryAfterSec: 0 })
    limiter.hit('a')
    expect(limiter.peek('a')).toEqual({ allowed: true, retryAfterSec: 10 })
    expect(limiter.peek('a')).toEqual({ allowed: true, retryAfterSec: 10 })
    limiter.hit('a')
    at(4_500)
    expect(limiter.peek('a')).toEqual({ allowed: false, retryAfterSec: 7 })
    at(10_999)
    expect(limiter.peek('a').allowed).toBe(false)
    at(11_000)
    expect(limiter.peek('a')).toEqual({ allowed: true, retryAfterSec: 0 })
    limiter.stop()
  })

  it('forgets a key on reset, and sweeps the windows that have ended, the one ending exactly now included', () => {
    const { limiter } = make(2, 10_000)
    limiter.hit('a')
    limiter.hit('b')
    limiter.reset('a')
    // A forgotten key has no window to wait for (a kept one would say 10 seconds), and starts counting afresh.
    expect(limiter.peek('a')).toEqual({ allowed: true, retryAfterSec: 0 })
    expect(limiter.hit('a')).toMatchObject({ remaining: 1 })
    limiter.sweep(10_999)
    expect(held(limiter)).toBe(2)
    limiter.sweep(11_000)
    expect(held(limiter)).toBe(0)
    limiter.hit('c')
    limiter.sweep(1)
    expect(held(limiter)).toBe(1)
    limiter.stop()
  })

  it('sweeps on its own timer, and stops it once', () => {
    vi.useFakeTimers()
    try {
      let t = 0
      const limiter = new RateLimiter(2, 1_000, () => t, 5_000)
      limiter.hit('a')
      t = 2_000
      vi.advanceTimersByTime(5_000)
      expect(held(limiter)).toBe(0)
      const clear = vi.spyOn(globalThis, 'clearInterval')
      limiter.stop()
      limiter.stop()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('totp: the edges', () => {
  const SECRET = base32Encode(Buffer.from('12345678901234567890'))

  it('encodes with the RFC 4648 vectors, no padding, and decodes them back with padding, blanks and case', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ]
    for (const [text, encoded] of vectors) {
      expect(base32Encode(Buffer.from(text)), text).toBe(encoded)
      expect(base32Decode(encoded).toString(), encoded).toBe(text)
    }
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar')
    expect(base32Decode('mzxw 6ytb\toi').toString()).toBe('foobar')
    expect(base32Decode('MZXW 6YTB OI ==').toString()).toBe('foobar')
  })

  it('refuses text that is not base32, padding anywhere but the end included', () => {
    expect(() => base32Decode('MZ=XW6')).toThrow('not base32')
    expect(() => base32Decode('MZXW1')).toThrow('not base32')
    expect(() => base32Decode('MZXW!')).toThrow('not base32')
  })

  it('accepts a code in the step before, at or after now, once, and only digits', () => {
    const at = 1_111_111_109_000
    const step = stepAt(at)
    expect(verifyCode(SECRET, codeFor(SECRET, step), at)).toBe(step)
    expect(verifyCode(SECRET, codeFor(SECRET, step - 1), at)).toBe(step - 1)
    expect(verifyCode(SECRET, codeFor(SECRET, step + 1), at)).toBe(step + 1)
    expect(verifyCode(SECRET, codeFor(SECRET, step - 2), at)).toBeNull()
    expect(verifyCode(SECRET, codeFor(SECRET, step + 2), at)).toBeNull()
    expect(verifyCode(SECRET, ` ${codeFor(SECRET, step)}\n`, at)).toBe(step)
    for (const bad of ['', '12345', '1234567', '12345a', 'abcdef', '12 345'])
      expect(verifyCode(SECRET, bad, at), bad).toBeNull()
    // A step already accepted, or an earlier one, is refused; a later one is not.
    expect(verifyCode(SECRET, codeFor(SECRET, step), at, step)).toBeNull()
    expect(verifyCode(SECRET, codeFor(SECRET, step), at, step + 1)).toBeNull()
    expect(verifyCode(SECRET, codeFor(SECRET, step), at, step - 1)).toBe(step)
    expect(verifyCode(SECRET, codeFor(SECRET, step - 1), at, step - 1)).toBeNull()
    expect(verifyCode(SECRET, codeFor(SECRET, step + 1), at, step)).toBe(step + 1)
  })

  it('accepts a code at the very start of time when none was accepted before', () => {
    expect(verifyCode(SECRET, codeFor(SECRET, 0), 0)).toBe(0)
    expect(verifyCode(SECRET, codeFor(SECRET, 0), 0, 0)).toBeNull()
  })

  it('writes the URI an authenticator app reads: the issuer and account in the label, the parameters of the code', () => {
    const uri = otpauthUri('ABC234', 'me@example.com')
    expect(uri.startsWith('otpauth://totp/tsmyadmin:me%40example.com?')).toBe(true)
    const params = new URL(uri).searchParams
    expect(Object.fromEntries(params)).toEqual({
      secret: 'ABC234',
      issuer: 'tsmyadmin',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    })
    const other = otpauthUri('S', 'a b', 'My App')
    expect(other.startsWith('otpauth://totp/My%20App:a%20b?')).toBe(true)
    expect(new URL(other).searchParams.get('issuer')).toBe('My App')
  })

  it('hashes a recovery code without its case, blanks and dashes', () => {
    // SHA-256 of "ABC".
    expect(hashRecoveryCode('ABC')).toBe('b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78')
    expect(hashRecoveryCode('abc')).toBe(hashRecoveryCode('ABC'))
    expect(hashRecoveryCode(' a-b c\t')).toBe(hashRecoveryCode('ABC'))
    expect(hashRecoveryCode('ABD')).not.toBe(hashRecoveryCode('ABC'))
  })
})
