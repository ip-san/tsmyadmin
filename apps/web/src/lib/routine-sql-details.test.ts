import { capabilities } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { callSql, literalFor, parseParameters, type RoutineParam } from './routine-call.ts'
import {
  bindLiteral,
  bindParameters,
  DEFAULT_RUN_OPTIONS,
  findParameters,
  isValidDelimiter,
  prepareScript,
} from './sql-prepare.ts'

/**
 * The statements the console builds for the user to run: a routine call, a script with its `:name` placeholders
 * bound, and the lines around it. Each is shown before it runs, but a wrong word is still a wrong statement (found by
 * mutation testing; see `bun run mutation`).
 */

const param = (mode: RoutineParam['mode'], name: string, type: string): RoutineParam => ({ mode, name, type })

describe('parseParameters', () => {
  it("reads the mode, name and type of each parameter, a MySQL procedure's and a PostgreSQL function's", () => {
    expect(parseParameters('IN uid int, OUT n int, INOUT t text')).toEqual([
      param('IN', 'uid', 'int'),
      param('OUT', 'n', 'int'),
      param('INOUT', 't', 'text'),
    ])
    expect(parseParameters('uid integer, name text')).toEqual([
      param('IN', 'uid', 'integer'),
      param('IN', 'name', 'text'),
    ])
    expect(parseParameters('out x int, inout y text, in z bigint')).toEqual([
      param('OUT', 'x', 'int'),
      param('INOUT', 'y', 'text'),
      param('IN', 'z', 'bigint'),
    ])
    expect(parseParameters('VARIADIC arr int[]')).toEqual([param('IN', 'arr', 'int[]')])
    expect(parseParameters('')).toEqual([])
    expect(parseParameters('  ,  ,')).toEqual([])
  })

  it('names an argument printed as its type alone by its place', () => {
    expect(parseParameters('integer, text')).toEqual([param('IN', 'arg1', 'integer'), param('IN', 'arg2', 'text')])
    expect(parseParameters('IN integer, OUT text')).toEqual([
      param('IN', 'arg1', 'integer'),
      param('OUT', 'arg2', 'text'),
    ])
    expect(parseParameters('uid int, text')).toEqual([param('IN', 'uid', 'int'), param('IN', 'arg2', 'text')])
  })

  it('does not split at a comma inside parentheses, brackets or quotes, and leaves off a DEFAULT', () => {
    expect(parseParameters('a numeric(10,2), b text')).toEqual([
      param('IN', 'a', 'numeric(10,2)'),
      param('IN', 'b', 'text'),
    ])
    expect(parseParameters('a int[], b int')).toEqual([param('IN', 'a', 'int[]'), param('IN', 'b', 'int')])
    expect(parseParameters("x text DEFAULT 'a,b', y int")).toEqual([param('IN', 'x', 'text'), param('IN', 'y', 'int')])
    expect(parseParameters('x text DEFAULT "a,b", y int')).toEqual([param('IN', 'x', 'text'), param('IN', 'y', 'int')])
    expect(parseParameters('x `we,ird` , y int')).toEqual([param('IN', 'x', '`we,ird`'), param('IN', 'y', 'int')])
    expect(parseParameters('a int = 5, b text')).toEqual([param('IN', 'a', 'int'), param('IN', 'b', 'text')])
    expect(parseParameters('a int default 5')).toEqual([param('IN', 'a', 'int')])
    expect(parseParameters('a   numeric (10, 2)')).toEqual([param('IN', 'a', 'numeric (10, 2)')])
    expect(parseParameters('a f(1,(2,3)), b int')).toEqual([param('IN', 'a', 'f(1,(2,3))'), param('IN', 'b', 'int')])
  })
})

describe('literalFor', () => {
  it('writes NULL for null, and a number as itself for a numeric parameter, trimmed', () => {
    expect(literalFor('mysql', 'int', null)).toBe('NULL')
    for (const type of [
      'int',
      'INT',
      'tinyint',
      'smallint',
      'mediumint',
      'bigint',
      'integer',
      'decimal(10,2)',
      'numeric',
      'float',
      'double',
      'real',
      'serial',
      'bigserial',
      'smallserial',
      'DOUBLE PRECISION',
    ]) {
      expect(literalFor('mysql', type, ' 12 '), type).toBe('12')
    }
    expect(literalFor('postgres', 'int', '-1.5')).toBe('-1.5')
    expect(literalFor('postgres', 'numeric', '1e5')).toBe('1e5')
    expect(literalFor('postgres', 'numeric', '-2.5E-3')).toBe('-2.5E-3')
  })

  it('quotes anything else: a non-number for a numeric parameter, any value for another type', () => {
    expect(literalFor('mysql', 'int', 'abc')).toBe("'abc'")
    expect(literalFor('mysql', 'int', '')).toBe("''")
    expect(literalFor('mysql', 'int', '1e')).toBe("'1e'")
    expect(literalFor('mysql', 'int', '1.')).toBe("'1.'")
    expect(literalFor('mysql', 'int', '1 2')).toBe("'1 2'")
    for (const type of ['text', 'varchar(20)', 'interval', 'point', 'date', 'uuid', 'xint', ''])
      expect(literalFor('mysql', type, '5'), type).toBe("'5'")
    expect(literalFor('mysql', 'text', "it's")).toBe("'it''s'")
    expect(literalFor('postgres', 'text', "it's")).toBe("'it''s'")
    expect(literalFor('mysql', 'text', 'a\\b')).toBe("'a\\\\b'")
    expect(literalFor('postgres', 'text', 'a\\b')).toBe("'a\\b'")
  })
})

describe('callSql', () => {
  const values = ['1', 'x', null]

  it('calls a function with a SELECT, leaving out OUT arguments', () => {
    const params = [param('IN', 'a', 'int'), param('OUT', 'b', 'text'), param('IN', 'c', 'text')]
    expect(callSql({ dialect: 'postgres', kind: 'function', name: 'f', params, values })).toBe('SELECT "f"(1, NULL);\n')
    expect(
      callSql({ dialect: 'mysql', kind: 'function', name: 'f', params: [param('IN', 'a', 'int')], values: ['7'] })
    ).toBe('SELECT `f`(7);\n')
    expect(callSql({ dialect: 'mysql', kind: 'function', name: 'f', params: [], values: [] })).toBe('SELECT `f`();\n')
    expect(callSql({ dialect: 'postgres', kind: 'function', name: 'we"ird', params: [], values: [] })).toBe(
      'SELECT "we""ird"();\n'
    )
  })

  it('calls a PostgreSQL procedure with NULL for each OUT argument and the values for the others', () => {
    const params = [param('IN', 'a', 'int'), param('OUT', 'b', 'text'), param('INOUT', 'c', 'text')]
    expect(callSql({ dialect: 'postgres', kind: 'procedure', name: 'p', params, values: ['1', 'ignored', 'z'] })).toBe(
      `CALL "p"(1, NULL, 'z');\n`
    )
    expect(callSql({ dialect: 'postgres', kind: 'procedure', name: 'p', params: [], values: [] })).toBe('CALL "p"();\n')
  })

  it('calls a MySQL procedure with user variables for OUT and INOUT, and selects them afterwards by name', () => {
    const params = [param('IN', 'a', 'int'), param('OUT', 'b', 'text'), param('INOUT', 'c', 'text')]
    expect(callSql({ dialect: 'mysql', kind: 'procedure', name: 'p', params, values: ['1', 'ignored', 'z'] })).toBe(
      [
        "SET @tsmyadmin_3 = 'z';",
        'CALL `p`(1, @tsmyadmin_2, @tsmyadmin_3);',
        'SELECT @tsmyadmin_2 AS `b`, @tsmyadmin_3 AS `c`;',
        '',
      ].join('\n')
    )
    expect(
      callSql({ dialect: 'mysql', kind: 'procedure', name: 'p', params: [param('IN', 'a', 'int')], values: ['1'] })
    ).toBe('CALL `p`(1);\n')
    expect(
      callSql({
        dialect: 'mysql',
        kind: 'procedure',
        name: 'p',
        params: [param('OUT', 'we`ird', 'int')],
        values: [null],
      })
    ).toBe(['CALL `p`(@tsmyadmin_1);', 'SELECT @tsmyadmin_1 AS `we``ird`;', ''].join('\n'))
  })

  it('writes NULL for a value that is not given', () => {
    expect(
      callSql({
        dialect: 'mysql',
        kind: 'procedure',
        name: 'p',
        params: [param('IN', 'a', 'int'), param('IN', 'b', 'int')],
        values: ['1'],
      })
    ).toBe('CALL `p`(1, NULL);\n')
  })
})

describe('findParameters', () => {
  it('lists the :name placeholders once each, in the order they first appear', () => {
    expect(findParameters('select :b, :a, :b where x = :c')).toEqual(['b', 'a', 'c'])
    expect(findParameters('select 1')).toEqual([])
    expect(findParameters('')).toEqual([])
    expect(findParameters('select :_x1, :ab12')).toEqual(['_x1', 'ab12'])
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
    expect(findParameters('select a[1:n]')).toEqual([])
  })

  it('skips casts, assignments, names with a gap or a digit first, and anything in a string, identifier or comment', () => {
    expect(findParameters('select a::int, b::text')).toEqual([])
    expect(findParameters('select a ::int')).toEqual(['int'].slice(0, 0))
    expect(findParameters('set @a := 1, @b := :v')).toEqual(['v'])
    expect(findParameters('select : a, :1, :-x')).toEqual([])
    expect(findParameters('select \':a\', ":b", `:c` -- :d\n, /* :e */ :f')).toEqual(['f'])
    expect(findParameters('select :a:b')).toEqual(['a'])
  })
})

describe('bindLiteral and bindParameters', () => {
  it('writes NULL, a plain number as itself trimmed, and anything else quoted for the dialect', () => {
    expect(bindLiteral('mysql', null)).toBe('NULL')
    expect(bindLiteral('mysql', ' 12 ')).toBe('12')
    expect(bindLiteral('mysql', '-5')).toBe('-5')
    expect(bindLiteral('mysql', '1.5')).toBe('1.5')
    expect(bindLiteral('mysql', '1e5')).toBe("'1e5'")
    expect(bindLiteral('mysql', '')).toBe("''")
    expect(bindLiteral('mysql', ' ')).toBe("' '")
    expect(bindLiteral('mysql', '1.')).toBe("'1.'")
    expect(bindLiteral('mysql', 'a\\b')).toBe("'a\\\\b'")
    expect(bindLiteral('postgres', 'a\\b')).toBe("'a\\b'")
    expect(bindLiteral('postgres', "it's")).toBe("'it''s'")
  })

  it('replaces each use of a name that has a value and leaves the rest of the text, and a name with no value, as it is', () => {
    expect(bindParameters('select :a, :b, :a from t where x = :c', 'mysql', { a: '1', b: "it's", c: null })).toBe(
      "select 1, 'it''s', 1 from t where x = NULL"
    )
    expect(bindParameters('select :a, :b', 'mysql', { a: '1' })).toBe('select 1, :b')
    expect(bindParameters('select :a', 'mysql', {})).toBe('select :a')
    expect(bindParameters("select ':a', :a -- :a\n", 'mysql', { a: '9' })).toBe("select ':a', 9 -- :a\n")
    expect(bindParameters('select a::int, :a', 'postgres', { a: '1' })).toBe('select a::int, 1')
    expect(bindParameters('', 'mysql', { a: '1' })).toBe('')
    expect(bindParameters('select :a', 'mysql', { a: '' })).toBe("select ''")
  })
})

describe('prepareScript', () => {
  const run = (sql: string, dialect: 'mysql' | 'postgres', o: Partial<typeof DEFAULT_RUN_OPTIONS>) =>
    prepareScript(sql, dialect, { ...DEFAULT_RUN_OPTIONS, ...o })

  it('sends the statement bound and nothing else with the default options', () => {
    expect(DEFAULT_RUN_OPTIONS).toEqual({ delimiter: ';', rollback: false, foreignKeyChecks: true, values: {} })
    expect(run('select :a', 'mysql', { values: { a: '1' } })).toBe('select 1')
    expect(run('select 1', 'postgres', {})).toBe('select 1')
  })

  it('puts foreign key checks off, then opens the transaction, then the delimiter, then the statement', () => {
    for (const dialect of ['mysql', 'postgres'] as const) {
      const caps = capabilities(dialect)
      expect(run('X', dialect, { foreignKeyChecks: false })).toBe(`${caps.foreignKeyChecksOff};\nX`)
      expect(run('X', dialect, { rollback: true })).toBe(`${caps.beginTransaction};\nX`)
      expect(run('X', dialect, { foreignKeyChecks: false, rollback: true })).toBe(
        `${caps.foreignKeyChecksOff};\n${caps.beginTransaction};\nX`
      )
    }
    expect(run('X', 'mysql', { foreignKeyChecks: false, rollback: true, delimiter: '//' })).toBe(
      `${capabilities('mysql').foreignKeyChecksOff};\n${capabilities('mysql').beginTransaction};\nDELIMITER //\nX`
    )
  })

  it('writes a DELIMITER line only where the dialect has one, for a valid delimiter that is not the default', () => {
    expect(run('X', 'mysql', { delimiter: '//' })).toBe('DELIMITER //\nX')
    expect(run('X', 'mysql', { delimiter: '$$' })).toBe('DELIMITER $$\nX')
    expect(run('X', 'mysql', { delimiter: ';' })).toBe('X')
    expect(run('X', 'mysql', { delimiter: '' })).toBe('X')
    expect(run('X', 'mysql', { delimiter: 'a b' })).toBe('X')
    expect(run('X', 'mysql', { delimiter: 'x'.repeat(17) })).toBe('X')
    expect(run('X', 'mysql', { delimiter: 'x'.repeat(16) })).toBe(`DELIMITER ${'x'.repeat(16)}\nX`)
    expect(run('X', 'postgres', { delimiter: '//' })).toBe('X')
  })

  it('knows a valid delimiter: one to sixteen characters with no blank in them', () => {
    for (const ok of [';', '//', '$$', '|', 'x'.repeat(16)]) expect(isValidDelimiter(ok), ok).toBe(true)
    for (const bad of ['', ' ', 'a b', 'a\tb', 'x'.repeat(17), ' ;', '; '])
      expect(isValidDelimiter(bad), JSON.stringify(bad)).toBe(false)
  })
})
