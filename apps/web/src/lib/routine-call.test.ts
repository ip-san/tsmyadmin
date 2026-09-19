import { describe, expect, it } from 'vitest'
import { callSql, literalFor, parseParameters } from './routine-call.ts'

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
    expect(parseParameters('')).toEqual([])
  })
})

describe('callSql', () => {
  const params = parseParameters('IN a int, INOUT b varchar(10), OUT c int')
  it('writes literals by type: numbers bare, text quoted with its quotes doubled, null as NULL', () => {
    expect(literalFor('int', '42')).toBe('42')
    expect(literalFor('int', 'x')).toBe("'x'")
    expect(literalFor('text', "it's")).toBe("'it''s'")
    expect(literalFor('text', null)).toBe('NULL')
  })

  it('runs a MySQL procedure through user variables and selects what comes back', () => {
    expect(callSql({ dialect: 'mysql', kind: 'procedure', name: 'p', params, values: ['1', 'x', null] })).toBe(
      "SET @tsmyadmin_2 = 'x';\nCALL `p`(1, @tsmyadmin_2, @tsmyadmin_3);\nSELECT @tsmyadmin_2 AS `b`, @tsmyadmin_3 AS `c`;\n"
    )
  })

  it('calls a PostgreSQL procedure with NULL for an OUT argument, and a function without its OUT ones', () => {
    expect(callSql({ dialect: 'postgres', kind: 'procedure', name: 'p', params, values: ['1', 'x', null] })).toBe(
      'CALL "p"(1, \'x\', NULL);\n'
    )
    expect(callSql({ dialect: 'postgres', kind: 'function', name: 'f', params, values: ['1', 'x', null] })).toBe(
      'SELECT "f"(1, \'x\');\n'
    )
  })
})
