import { describe, expect, it } from 'vitest'
import { callSql, literalFor, parseParameters, type RoutineParam } from './routine-call.ts'

/**
 * The statement the console builds to run a routine. It is shown before it runs, but a wrong word is still a wrong
 * statement (the edge cases were found by mutation testing; see `bun run mutation`).
 */

const param = (mode: RoutineParam['mode'], name: string, type: string): RoutineParam => ({ mode, name, type })

describe('parseParameters', () => {
  it('reads modes, names and types, keeping commas inside a type together and leaving a DEFAULT off', () => {
    expect(parseParameters('IN uid int, OUT total decimal(10,2), INOUT s varchar(20)')).toEqual([
      { mode: 'IN', name: 'uid', type: 'int' },
      { mode: 'OUT', name: 'total', type: 'decimal(10,2)' },
      { mode: 'INOUT', name: 's', type: 'varchar(20)' },
    ])
    expect(parseParameters("n integer, label text DEFAULT 'a,b'")).toEqual([
      { mode: 'IN', name: 'n', type: 'integer' },
      { mode: 'IN', name: 'label', type: 'text' },
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

  it('keeps a bracketed default whole and reads an unnamed argument as its type', () => {
    expect(parseParameters('a integer[] DEFAULT ARRAY[1, 2], b text')).toEqual([
      { mode: 'IN', name: 'a', type: 'integer[]' },
      { mode: 'IN', name: 'b', type: 'text' },
    ])
    expect(parseParameters('integer, text')).toEqual([
      { mode: 'IN', name: 'arg1', type: 'integer' },
      { mode: 'IN', name: 'arg2', type: 'text' },
    ])
    expect(parseParameters('IN integer, OUT text')).toEqual([
      param('IN', 'arg1', 'integer'),
      param('OUT', 'arg2', 'text'),
    ])
    expect(parseParameters('uid int, text')).toEqual([param('IN', 'uid', 'int'), param('IN', 'arg2', 'text')])
  })

  it('does not split at a comma inside parentheses, brackets or quotes, and leaves off a DEFAULT or = value', () => {
    expect(parseParameters('x text DEFAULT "a,b", y int')).toEqual([param('IN', 'x', 'text'), param('IN', 'y', 'int')])
    expect(parseParameters('x `we,ird` , y int')).toEqual([param('IN', 'x', '`we,ird`'), param('IN', 'y', 'int')])
    expect(parseParameters('a int = 5, b text')).toEqual([param('IN', 'a', 'int'), param('IN', 'b', 'text')])
    expect(parseParameters('a int default 5')).toEqual([param('IN', 'a', 'int')])
    expect(parseParameters('a   numeric (10, 2)')).toEqual([param('IN', 'a', 'numeric (10, 2)')])
    expect(parseParameters('a f(1,(2,3)), b int')).toEqual([param('IN', 'a', 'f(1,(2,3))'), param('IN', 'b', 'int')])
  })
})

describe('literalFor', () => {
  it('writes literals by type: numbers bare, text quoted with its quotes doubled, null as NULL', () => {
    expect(literalFor('mysql', 'int', '42')).toBe('42')
    expect(literalFor('mysql', 'int', 'x')).toBe("'x'")
    expect(literalFor('mysql', 'text', "it's")).toBe("'it''s'")
    expect(literalFor('postgres', 'text', "it's")).toBe("'it''s'")
    expect(literalFor('mysql', 'text', null)).toBe('NULL')
    // A backslash escapes on MySQL and is an ordinary character on PostgreSQL.
    expect(literalFor('mysql', 'text', 'C:\\temp')).toBe("'C:\\\\temp'")
    expect(literalFor('postgres', 'text', 'C:\\temp')).toBe("'C:\\temp'")
  })

  it('writes a number as itself for any numeric type, in any case, trimmed', () => {
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
    expect(literalFor('mysql', 'int', '')).toBe("''")
    expect(literalFor('mysql', 'int', '1e')).toBe("'1e'")
    expect(literalFor('mysql', 'int', '1.')).toBe("'1.'")
    expect(literalFor('mysql', 'int', '1 2')).toBe("'1 2'")
    for (const type of ['text', 'varchar(20)', 'interval', 'point', 'date', 'uuid', 'xint', ''])
      expect(literalFor('mysql', type, '5'), type).toBe("'5'")
  })
})

describe('callSql', () => {
  const params = parseParameters('IN a int, INOUT b varchar(10), OUT c int')

  it('runs a MySQL procedure through user variables and selects what comes back', () => {
    expect(callSql({ dialect: 'mysql', kind: 'procedure', name: 'p', params, values: ['1', 'x', null] })).toBe(
      "SET @tsmyadmin_2 = 'x';\nCALL `p`(1, @tsmyadmin_2, @tsmyadmin_3);\nSELECT @tsmyadmin_2 AS `b`, @tsmyadmin_3 AS `c`;\n"
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

  it('calls a PostgreSQL procedure with NULL for an OUT argument, and a function without its OUT ones', () => {
    expect(callSql({ dialect: 'postgres', kind: 'procedure', name: 'p', params, values: ['1', 'x', null] })).toBe(
      'CALL "p"(1, \'x\', NULL);\n'
    )
    expect(callSql({ dialect: 'postgres', kind: 'function', name: 'f', params, values: ['1', 'x', null] })).toBe(
      'SELECT "f"(1, \'x\');\n'
    )
    expect(callSql({ dialect: 'postgres', kind: 'procedure', name: 'p', params: [], values: [] })).toBe('CALL "p"();\n')
    expect(callSql({ dialect: 'mysql', kind: 'function', name: 'f', params: [], values: [] })).toBe('SELECT `f`();\n')
    expect(callSql({ dialect: 'postgres', kind: 'function', name: 'we"ird', params: [], values: [] })).toBe(
      'SELECT "we""ird"();\n'
    )
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
