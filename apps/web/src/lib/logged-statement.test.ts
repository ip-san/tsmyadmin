import { describe, expect, it } from 'vitest'
import { loggedStatementPlan, namedParameters } from './logged-statement.ts'
import { findParameters } from './sql-prepare.ts'

describe('namedParameters', () => {
  it("turns pg_stat_statements' numbered parameters into the console's named ones", () => {
    expect(namedParameters('SELECT * FROM t WHERE a = $1 AND b IN ($2,$10) LIMIT $3')).toBe(
      'SELECT * FROM t WHERE a = :p1 AND b IN (:p2,:p10) LIMIT :p3'
    )
    expect(findParameters(namedParameters('SELECT * FROM t WHERE a = $1 AND b IN ($2,$10)'))).toEqual([
      'p1',
      'p2',
      'p10',
    ])
  })

  it('keeps a cast after it, and reads as a parameter where it was glued to a bracket', () => {
    const sql = namedParameters('SELECT a[$1], $2::int FROM t')
    expect(sql).toBe('SELECT a[ :p1], :p2::int FROM t')
    expect(findParameters(sql)).toEqual(['p1', 'p2'])
  })

  it('leaves strings, identifiers, comments and dollar quotes as they are', () => {
    const sql = `SELECT '$1', "$2", $$ $3 $$ /* $4 */ FROM t -- $5`
    expect(namedParameters(sql)).toBe(sql)
    expect(namedParameters('SELECT a$1 FROM t')).toBe('SELECT a$1 FROM t')
  })
})

describe('loggedStatementPlan', () => {
  const hints = { fill: 'give values', forAny: 'for any value' }

  it('draws at once a statement logged with its values', () => {
    expect(loggedStatementPlan('  SELECT * FROM t WHERE a = 1 ', hints, true)).toEqual({
      sql: 'SELECT * FROM t WHERE a = 1',
      drawn: true,
    })
  })

  it('asks for the values a statement was logged without, before its plan is drawn, where the server needs them', () => {
    expect(loggedStatementPlan('UPDATE t SET a = $1 WHERE id = $2', hints, false)).toEqual({
      sql: '-- give values\nUPDATE t SET a = :p1 WHERE id = :p2',
      drawn: false,
    })
  })

  it('draws at once, for any value, a statement logged without its values where the server can', () => {
    expect(loggedStatementPlan('UPDATE t SET a = $1 WHERE id = $2', hints, true)).toEqual({
      sql: '-- for any value\nUPDATE t SET a = :p1 WHERE id = :p2',
      drawn: true,
    })
  })

  it('offers no plan for what EXPLAIN does not take', () => {
    expect(loggedStatementPlan('COMMIT', hints, true)).toBeNull()
    expect(loggedStatementPlan('SET search_path = $1', hints, true)).toBeNull()
    expect(loggedStatementPlan('CALL p($1)', hints, true)).toBeNull()
  })
})
