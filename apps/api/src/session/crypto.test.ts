import { describe, expect, it } from 'vitest'
import { deriveSessionKey, open, seal } from './crypto.ts'

describe('session crypto', () => {
  it('round-trips and never reuses an IV', () => {
    const key = deriveSessionKey('a-secret')
    const a = seal(key, '{"password":"pw"}')
    const b = seal(key, '{"password":"pw"}')
    expect(open(key, a)).toBe('{"password":"pw"}')
    expect(a.equals(b)).toBe(false)
    expect(a.toString('utf8')).not.toContain('pw')
  })

  it('rejects tampering and a different secret', () => {
    const key = deriveSessionKey('a-secret')
    const sealed = seal(key, 'hello')
    const tampered = Buffer.from(sealed)
    const last = tampered.length - 1
    tampered[last] = (tampered[last] ?? 0) ^ 0xff
    expect(() => open(key, tampered)).toThrow()
    expect(() => open(deriveSessionKey('other'), sealed)).toThrow()
    expect(() => open(key, Buffer.alloc(3))).toThrow(/too short/)
  })
})
