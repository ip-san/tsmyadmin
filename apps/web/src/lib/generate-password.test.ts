import { describe, expect, it } from 'vitest'
import { generatePassword } from './generate-password.ts'

describe('generatePassword', () => {
  it('makes the length asked for, from characters without look-alikes', () => {
    const password = generatePassword(24)
    expect(password).toHaveLength(24)
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/)
  })

  it('draws again for a value that would favour some characters', () => {
    // 0xffffffff is above the unbiased limit and is skipped; 0 and 1 make "AB".
    const draws = [new Uint32Array([0xffff_ffff, 0, 1])]
    expect(generatePassword(2, () => draws.shift() ?? new Uint32Array([2, 3]))).toBe('AB')
  })

  it('differs between calls', () => {
    expect(generatePassword()).not.toBe(generatePassword())
  })
})
