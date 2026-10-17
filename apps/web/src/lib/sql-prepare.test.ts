import { capabilities } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import {
  bindLiteral,
  bindParameters,
  DEFAULT_RUN_OPTIONS,
  findParameters,
  isValidDelimiter,
  prepareScript,
  prepareStatement,
} from './sql-prepare.ts'

/**
 * A script with its `:name` placeholders bound and the lines the run options put around it. It is shown before it
 * runs, but a wrong word is still a wrong statement (the edge cases were found by mutation testing).
 */

describe('findParameters', () => {
  it('finds :name placeholders once each, in order', () => {
    expect(findParameters('select * from t where a = :id and b = :name or c = :id')).toEqual(['id', 'name'])
    expect(findParameters('select * from t where a in (:x,:y)')).toEqual(['x', 'y'])
    expect(findParameters('select :_x1, :ab12')).toEqual(['_x1', 'ab12'])
    expect(findParameters('select 1')).toEqual([])
    expect(findParameters('')).toEqual([])
  })

  it('stands for a placeholder after the punctuation that can precede one, or after a space, and nowhere else', () => {
    expect(findParameters('f(:a,:b) where c=:d and e<:f or g>:h')).toEqual(['a', 'b', 'd', 'f', 'h'])
    expect(findParameters('select 1+:a, 2-:b, 3*:c, 4/:d, 5%:e, !:f, x|:g, y&:h')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
    ])
    expect(findParameters('select x :a')).toEqual(['a'])
    expect(findParameters('select x:a')).toEqual([])
    expect(findParameters('select :a:b')).toEqual(['a'])
  })

  it('skips strings, comments, casts, assignments, slices and names with a gap or a digit first', () => {
    expect(findParameters('select \':no\', ":no", `:no` -- :no\n /* :no */ , a::int, b := 1, arr[1:n]')).toEqual([])
    expect(findParameters('select a::int, :yes')).toEqual(['yes'])
    expect(findParameters('select a ::int')).toEqual([])
    expect(findParameters('set @a := 1, @b := :v')).toEqual(['v'])
    expect(findParameters('select : a, :1, :-x')).toEqual([])
  })
})

describe('bindParameters', () => {
  it('writes each value as a literal in place of its placeholder', () => {
    const sql = "select * from t where id = :id and name = :name and x = ':id'"
    expect(bindParameters(sql, 'mysql', { id: '7', name: "it's" })).toBe(
      "select * from t where id = 7 and name = 'it''s' and x = ':id'"
    )
    expect(bindParameters('select :a, :b, :a from t where x = :c', 'mysql', { a: '1', b: "it's", c: null })).toBe(
      "select 1, 'it''s', 1 from t where x = NULL"
    )
    expect(bindParameters("select ':a', :a -- :a\n", 'mysql', { a: '9' })).toBe("select ':a', 9 -- :a\n")
    expect(bindParameters('select a::int, :a', 'postgres', { a: '1' })).toBe('select a::int, 1')
    expect(bindParameters('', 'mysql', { a: '1' })).toBe('')
    expect(bindParameters('select :a', 'mysql', { a: '' })).toBe("select ''")
  })

  it('escapes a backslash on MySQL only, writes NULL, and leaves an unvalued name alone', () => {
    expect(bindLiteral('mysql', 'a\\b')).toBe("'a\\\\b'")
    expect(bindLiteral('postgres', 'a\\b')).toBe("'a\\b'")
    expect(bindLiteral('postgres', "it's")).toBe("'it''s'")
    expect(bindLiteral('mysql', null)).toBe('NULL')
    expect(bindParameters('select :a, :b', 'mysql', { a: null })).toBe('select NULL, :b')
    expect(bindParameters('select :a', 'mysql', {})).toBe('select :a')
  })

  it('writes a plain number as itself trimmed, and anything else quoted', () => {
    expect(bindLiteral('mysql', ' 12 ')).toBe('12')
    expect(bindLiteral('mysql', '-5')).toBe('-5')
    expect(bindLiteral('mysql', '1.5')).toBe('1.5')
    expect(bindLiteral('mysql', '1e5')).toBe("'1e5'")
    expect(bindLiteral('mysql', '1.')).toBe("'1.'")
    expect(bindLiteral('mysql', '')).toBe("''")
    expect(bindLiteral('mysql', ' ')).toBe("' '")
  })
})

describe('prepareScript', () => {
  const run = (sql: string, dialect: 'mysql' | 'postgres', o: Partial<typeof DEFAULT_RUN_OPTIONS>) =>
    prepareScript(sql, dialect, { ...DEFAULT_RUN_OPTIONS, ...o })

  it('sends the text as it is by default, bound', () => {
    expect(prepareScript('select 1', 'mysql', DEFAULT_RUN_OPTIONS)).toBe('select 1')
    expect(run('select :a', 'mysql', { values: { a: '1' } })).toBe('select 1')
  })

  it('runs the extras first, then a DELIMITER line, then the statements', () => {
    const options = { ...DEFAULT_RUN_OPTIONS, delimiter: '$$', rollback: true, foreignKeyChecks: false }
    expect(prepareScript('select 1$$', 'mysql', options)).toBe(
      'SET FOREIGN_KEY_CHECKS = 0;\nSTART TRANSACTION;\nDELIMITER $$\nselect 1$$'
    )
    expect(prepareScript('select 1', 'postgres', options)).toBe(
      'SET session_replication_role = replica;\nBEGIN;\nselect 1'
    )
  })

  it('puts foreign key checks off, then opens the transaction, each on its own as well', () => {
    for (const dialect of ['mysql', 'postgres'] as const) {
      const caps = capabilities(dialect)
      expect(run('X', dialect, { foreignKeyChecks: false })).toBe(`${caps.foreignKeyChecksOff};\nX`)
      expect(run('X', dialect, { rollback: true })).toBe(`${caps.beginTransaction};\nX`)
    }
  })

  it('writes a DELIMITER line only on MySQL, for a valid delimiter that is not the default', () => {
    expect(run('X', 'mysql', { delimiter: '//' })).toBe('DELIMITER //\nX')
    expect(run('X', 'mysql', { delimiter: ';' })).toBe('X')
    expect(run('X', 'mysql', { delimiter: '' })).toBe('X')
    expect(run('X', 'mysql', { delimiter: 'a b' })).toBe('X')
    expect(run('X', 'mysql', { delimiter: 'x'.repeat(17) })).toBe('X')
    expect(run('X', 'mysql', { delimiter: 'x'.repeat(16) })).toBe(`DELIMITER ${'x'.repeat(16)}\nX`)
    expect(run('X', 'postgres', { delimiter: '$$' })).toBe('X')
  })

  it('knows a valid delimiter: one to sixteen characters with no blank in them', () => {
    for (const ok of [';', '//', '$$', '|', 'x'.repeat(16)]) expect(isValidDelimiter(ok), ok).toBe(true)
    for (const bad of ['', ' ', 'a b', 'a\tb', 'x'.repeat(17), ' ;', '; '])
      expect(isValidDelimiter(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('prepareStatement', () => {
  const one = (sql: string, dialect: 'mysql' | 'postgres', o: Partial<typeof DEFAULT_RUN_OPTIONS> = {}) =>
    prepareStatement(sql, dialect, { ...DEFAULT_RUN_OPTIONS, ...o })

  it('fills in the parameters like a run', () => {
    expect(one('SELECT * FROM t WHERE id = :id', 'postgres', { values: { id: '3' } })).toBe(
      'SELECT * FROM t WHERE id = 3'
    )
  })

  it('takes off the custom delimiter that ends it, and nothing else', () => {
    expect(one('SELECT 1$$\n', 'mysql', { delimiter: '$$' })).toBe('SELECT 1')
    expect(one('SELECT 1;', 'mysql')).toBe('SELECT 1;')
    expect(one("SELECT '$$'", 'mysql', { delimiter: '$$' })).toBe("SELECT '$$'")
  })

  it('leaves the text alone where the dialect has no delimiter line', () => {
    expect(one('SELECT 1$$', 'postgres', { delimiter: '$$' })).toBe('SELECT 1$$')
  })

  it('leaves the text alone when the delimiter it was given is not one', () => {
    expect(one('SELECT 1 x', 'mysql', { delimiter: ' x' })).toBe('SELECT 1 x')
  })
})
