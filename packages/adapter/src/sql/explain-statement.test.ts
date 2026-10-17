import { EXPLAIN_RAW_MAX } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { explainableStatement, explainResult, parseJsonCell } from './explain-statement.ts'

describe('explainableStatement', () => {
  it('takes one statement, without its leading comments and trailing semicolon', () => {
    expect(explainableStatement('-- why\nSELECT 1;', 'mysql')).toBe('SELECT 1')
    expect(explainableStatement('  /* x */ UPDATE t SET a = 1', 'postgres')).toBe('UPDATE t SET a = 1')
    expect(explainableStatement('(SELECT 1) UNION (SELECT 2)', 'mysql')).toBe('(SELECT 1) UNION (SELECT 2)')
  })

  it.each([
    ['two statements', 'SELECT 1; DROP TABLE t'],
    ['an EXPLAIN', 'EXPLAIN SELECT 1'],
    ['an ANALYZE (it runs the statement)', 'ANALYZE SELECT 1'],
    ['DDL', 'DROP TABLE t'],
    ['a SET', 'SET @a = 1'],
    ['nothing', '-- only a comment'],
  ])('refuses %s', (_, sql) => {
    expect(() => explainableStatement(sql, 'mysql')).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('does not split on a semicolon in a string', () => {
    expect(explainableStatement("SELECT ';' FROM t", 'postgres')).toBe("SELECT ';' FROM t")
  })
})

describe('explainResult', () => {
  const plan = {
    op: 'x',
    table: null,
    alias: null,
    index: null,
    indexColumns: [],
    access: null,
    covering: false,
    estRows: null,
    cost: null,
    detail: null,
    children: [],
  }

  it('keeps the raw plan, cut when it is long', () => {
    expect(explainResult(plan, { a: 1 })).toEqual({ plan, raw: '{\n  "a": 1\n}', rawTruncated: false })
    const long = explainResult(plan, 'x'.repeat(EXPLAIN_RAW_MAX + 10))
    expect(long.raw).toHaveLength(EXPLAIN_RAW_MAX)
    expect(long.rawTruncated).toBe(true)
  })

  it('reads JSON given as text or already parsed', () => {
    expect(parseJsonCell('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonCell([1])).toEqual([1])
  })
})
