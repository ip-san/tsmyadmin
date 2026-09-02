import { describe, expect, it } from 'vitest'
import { isSingleStatement, stripTrailingSemicolons } from './statement.ts'

describe('statement helpers', () => {
  it('detects a single statement regardless of trailing semicolons', () => {
    expect(isSingleStatement('SELECT 1')).toBe(true)
    expect(isSingleStatement('  SELECT 1;;  ')).toBe(true)
    expect(isSingleStatement('SELECT 1; SELECT 2')).toBe(false)
    expect(isSingleStatement('')).toBe(false)
    expect(isSingleStatement(';')).toBe(false)
  })

  it('strips trailing semicolons only', () => {
    expect(stripTrailingSemicolons('SELECT 1; ')).toBe('SELECT 1')
    expect(stripTrailingSemicolons('a; b;')).toBe('a; b')
  })
})
