import { describe, expect, it } from 'vitest'
import { isSingleStatement, stripTrailingSemicolons, unboundedWrites } from './statement.ts'

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

describe('unboundedWrites', () => {
  it('finds an UPDATE or DELETE with no WHERE', () => {
    expect(unboundedWrites('UPDATE t SET a = 1')).toEqual(['UPDATE'])
    expect(unboundedWrites('DELETE FROM t')).toEqual(['DELETE'])
    expect(unboundedWrites('UPDATE t SET a = 1 WHERE id = 2')).toEqual([])
    expect(unboundedWrites('SELECT * FROM t')).toEqual([])
  })

  it('looks at each statement of a script separately', () => {
    expect(unboundedWrites('UPDATE a SET x = 1 WHERE id = 1;\nDELETE FROM b;')).toEqual(['DELETE'])
    expect(unboundedWrites('SELECT 1;\nUPDATE t SET a = 1;\nDELETE FROM u WHERE id = 1;')).toEqual(['UPDATE'])
  })

  it('does not read keywords out of comments or string literals', () => {
    // A WHERE that only appears in a comment does not bound anything.
    expect(unboundedWrites('UPDATE t SET a = 1 -- WHERE id = 2')).toEqual(['UPDATE'])
    expect(unboundedWrites("UPDATE t SET note = 'WHERE'")).toEqual(['UPDATE'])
    // ...and a statement that only looks like a DELETE inside a string is not one.
    expect(unboundedWrites("SELECT 'DELETE FROM t'")).toEqual([])
    expect(unboundedWrites('/* DELETE FROM t */ SELECT 1')).toEqual([])
  })

  it('still warns when only a LIMIT bounds the statement', () => {
    // A LIMIT caps how many rows change, not which ones.
    expect(unboundedWrites('DELETE FROM t LIMIT 10')).toEqual(['DELETE'])
  })
})
