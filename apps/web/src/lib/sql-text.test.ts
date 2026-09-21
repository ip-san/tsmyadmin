import { describe, expect, it } from 'vitest'
import { explainStatement, stripTrailingSemicolons } from './sql-text.ts'

describe('sql text', () => {
  it('strips trailing semicolons only', () => {
    expect(stripTrailingSemicolons('SELECT 1; ')).toBe('SELECT 1')
    expect(stripTrailingSemicolons('a; b;')).toBe('a; b')
  })

  it('prefixes EXPLAIN and drops trailing semicolons', () => {
    expect(explainStatement('SELECT 1;')).toBe('EXPLAIN SELECT 1')
  })

  it('does not prefix a statement that already starts with EXPLAIN', () => {
    expect(explainStatement('EXPLAIN SELECT 1')).toBe('EXPLAIN SELECT 1')
    expect(explainStatement('  explain select 1;')).toBe('explain select 1')
  })
})
