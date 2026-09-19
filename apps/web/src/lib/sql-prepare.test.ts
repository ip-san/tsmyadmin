import { describe, expect, it } from 'vitest'
import { bindLiteral, bindParameters, DEFAULT_RUN_OPTIONS, findParameters, prepareScript } from './sql-prepare.ts'

describe('findParameters', () => {
  it('finds :name placeholders once each, in order', () => {
    expect(findParameters('select * from t where a = :id and b = :name or c = :id')).toEqual(['id', 'name'])
    expect(findParameters('select * from t where a in (:x,:y)')).toEqual(['x', 'y'])
  })

  it('skips strings, comments, casts, assignments and slices', () => {
    expect(findParameters('select \':no\', ":no", `:no` -- :no\n /* :no */ , a::int, b := 1, arr[1:n]')).toEqual([])
    expect(findParameters('select a::int, :yes')).toEqual(['yes'])
  })
})

describe('bindParameters', () => {
  it('writes each value as a literal in place of its placeholder', () => {
    const sql = "select * from t where id = :id and name = :name and x = ':id'"
    expect(bindParameters(sql, 'mysql', { id: '7', name: "it's" })).toBe(
      "select * from t where id = 7 and name = 'it''s' and x = ':id'"
    )
  })

  it('escapes a backslash on MySQL only, writes NULL, and leaves an unvalued name alone', () => {
    expect(bindLiteral('mysql', 'a\\b')).toBe("'a\\\\b'")
    expect(bindLiteral('postgres', 'a\\b')).toBe("'a\\b'")
    expect(bindLiteral('mysql', null)).toBe('NULL')
    expect(bindLiteral('mysql', '1e5')).toBe("'1e5'")
    expect(bindParameters('select :a, :b', 'mysql', { a: null })).toBe('select NULL, :b')
  })
})

describe('prepareScript', () => {
  it('sends the text as it is by default', () => {
    expect(prepareScript('select 1', 'mysql', DEFAULT_RUN_OPTIONS)).toBe('select 1')
  })

  it('runs the extras first, then a DELIMITER line, then the statements', () => {
    const options = { ...DEFAULT_RUN_OPTIONS, delimiter: '$$', rollback: true, foreignKeyChecks: false }
    expect(prepareScript('select 1$$', 'mysql', options)).toBe(
      'SET FOREIGN_KEY_CHECKS = 0;\nSTART TRANSACTION;\nDELIMITER $$\nselect 1$$'
    )
    expect(prepareScript('select 1', 'postgres', options)).toBe(
      "SET session_replication_role = 'replica';\nBEGIN;\nselect 1"
    )
  })

  it('ignores a delimiter that is not one word, and on PostgreSQL', () => {
    expect(prepareScript('select 1', 'mysql', { ...DEFAULT_RUN_OPTIONS, delimiter: 'a b' })).toBe('select 1')
    expect(prepareScript('select 1', 'postgres', { ...DEFAULT_RUN_OPTIONS, delimiter: '$$' })).toBe('select 1')
  })
})
