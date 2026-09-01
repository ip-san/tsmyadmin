import { describe, expect, it } from 'vitest'
import { countMode } from './base.ts'

describe('countMode', () => {
  it('uses the catalog estimate only for large unfiltered browses', () => {
    expect(countMode(false, 5, 100)).toBe('exact')
    expect(countMode(false, 100, 100)).toBe('exact')
    expect(countMode(false, 101, 100)).toBe('estimate')
    expect(countMode(true, 1_000_000, 100)).toBe('exact')
    expect(countMode(false, null, 100)).toBe('exact')
  })
})
