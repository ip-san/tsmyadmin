import type { PlanNode } from '@tsmyadmin/shared'
import { EXPLAIN_RAW_MAX } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { explainableStatement, explainResult, measurableStatement, parseJsonCell } from './explain-statement.ts'

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

describe('measurableStatement', () => {
  it('takes a plain read, as explainableStatement gives it', () => {
    expect(measurableStatement('-- why\nSELECT 1;', 'mysql')).toBe('SELECT 1')
    expect(measurableStatement('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres')).toBe(
      'WITH x AS (SELECT 1) SELECT * FROM x'
    )
    expect(measurableStatement('TABLE users', 'postgres')).toBe('TABLE users')
    // A word in a literal is data.
    expect(measurableStatement("SELECT 'delete' FROM t", 'mysql')).toBe("SELECT 'delete' FROM t")
  })

  it.each([
    ['a write', 'UPDATE t SET a = 1'],
    ['a write inside a WITH', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'],
    ['a locking read', 'SELECT * FROM t FOR UPDATE'],
    ['a shared lock', 'SELECT * FROM t LOCK IN SHARE MODE'],
    ['a read into a file', "SELECT * FROM t INTO OUTFILE '/tmp/x'"],
    ['two statements', 'SELECT 1; SELECT 2'],
  ])('refuses %s', (_, sql) => {
    expect(() => measurableStatement(sql, 'mysql')).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
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

describe('explainResult, measured', () => {
  it('carries the time of the run only where there was one', () => {
    const node: PlanNode = {
      ...{ op: 'x', table: null, alias: null, index: null, indexColumns: [], access: null, covering: false },
      ...{ estRows: null, cost: null, detail: null, children: [] },
    }
    expect(explainResult(node, {}, { ms: 2 }).measured).toEqual({ ms: 2 })
    expect('measured' in explainResult(node, {})).toBe(false)
  })
})
