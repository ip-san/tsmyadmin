import { describe, expect, it } from 'vitest'
import { countMode } from './base.ts'

describe('countMode', () => {
  it('uses the catalog estimate only when it exceeds the threshold', () => {
    expect(countMode(5, 100)).toBe('exact')
    expect(countMode(100, 100)).toBe('exact')
    expect(countMode(101, 100)).toBe('estimate')
    expect(countMode(null, 100)).toBe('exact')
  })
})
