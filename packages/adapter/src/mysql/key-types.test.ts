import { describe, expect, it } from 'vitest'
import { keyColumnExpr, keyMatchExpr, keyParam } from './key-types.ts'

describe('keyParam: a key value typed for the column it is compared with', () => {
  it.each([
    ['int', 'CAST(? AS SIGNED)'],
    ['INT', 'CAST(? AS SIGNED)'],
    ['bigint', 'CAST(? AS SIGNED)'],
    ['tinyint(1)', 'CAST(? AS SIGNED)'],
    // An UNSIGNED column needs the unsigned cast: 2^64-2 as SIGNED is -2.
    ['bigint unsigned', 'CAST(? AS UNSIGNED)'],
    ['mediumint unsigned', 'CAST(? AS UNSIGNED)'],
    ['int(11) unsigned', 'CAST(? AS UNSIGNED)'],
    // A FLOAT column holding 0.1 is not equal to the DOUBLE literal 0.1.
    ['float', 'CAST(? AS FLOAT)'],
    ['FLOAT(7,4)', 'CAST(? AS FLOAT)'],
    ['decimal(10,2)', 'CAST(? AS DECIMAL(10,2))'],
    ['DECIMAL(5, 0)', 'CAST(? AS DECIMAL(5,0))'],
    ['json', 'CAST(? AS JSON)'],
    ['JSON', 'CAST(? AS JSON)'],
    // A BIT value travels as a binary literal; MariaDB would read it as a binary string, so it becomes a number.
    ['bit(1)', 'CAST(CONV(HEX(?), 16, 10) AS UNSIGNED)'],
  ])('%s', (type, expected) => {
    expect(keyParam('?', type)).toBe(expected)
  })

  it.each(['', 'double', 'decimal', 'varchar(255)', 'text', 'datetime', 'blob'])(
    "leaves a %j column's value as it is",
    (type) => {
      expect(keyParam('?', type)).toBe('?')
    }
  )

  it('wraps whatever placeholder it is given', () => {
    expect(keyParam('$1', 'json')).toBe('CAST($1 AS JSON)')
  })
})

describe('keyMatchExpr: an all-columns key must match byte for byte', () => {
  const bytes = 'CAST(CONVERT(`c` USING utf8mb4) AS BINARY)'
  it.each(['char(3)', 'varchar(255)', 'tinytext', 'text', 'mediumtext', 'longtext', "enum('a','b')", "set('p','q')"])(
    'compares a %s column as binary, so case, accent and trailing space differ',
    (type) => {
      expect(keyMatchExpr('`c`', type)).toBe(bytes)
    }
  )

  it.each(['', 'int', 'blob', 'varbinary(16)', 'datetime'])('leaves a %j column as it is', (type) => {
    expect(keyMatchExpr('`c`', type)).toBe('`c`')
  })
})

describe('keyColumnExpr: what a scan orders by', () => {
  it.each(["enum('a','b')", "ENUM('x')", "set('p','q')"])(
    'pages an %s column over its label in the binary collation, not its member index',
    (type) => {
      expect(keyColumnExpr('`c`', type)).toBe('CAST(`c` AS CHAR) COLLATE utf8mb4_bin')
    }
  )

  it.each(['', 'varchar(255)', 'int'])('orders a %j column by itself', (type) => {
    expect(keyColumnExpr('`c`', type)).toBe('`c`')
  })
})

describe('the patterns match the whole type, from its start', () => {
  it('does not take a type that merely contains or ends in a known word for it', () => {
    expect(keyParam('?', 'xjson')).toBe('?')
    expect(keyParam('?', 'json_extra')).toBe('CAST(? AS JSON)')
    expect(keyParam('?', 'point')).toBe('?')
    expect(keyParam('?', 'multipoint')).toBe('?')
    expect(keyParam('?', 'xdecimal(10,2)')).toBe('?')
    expect(keyParam('?', 'bitx')).toBe('CAST(CONV(HEX(?), 16, 10) AS UNSIGNED)')
    expect(keyParam('?', 'xbit')).toBe('?')
    expect(keyColumnExpr('`c`', 'xenum(1)')).toBe('`c`')
    expect(keyColumnExpr('`c`', 'multiset(1)')).toBe('`c`')
  })

  it('keeps every digit of a decimal precision and scale', () => {
    expect(keyParam('?', 'decimal(30,12)')).toBe('CAST(? AS DECIMAL(30,12))')
    expect(keyParam('?', 'decimal(65, 30)')).toBe('CAST(? AS DECIMAL(65,30))')
  })

  it('writes an enum or set column by its label in the binary collation', () => {
    expect(keyColumnExpr('`c`', "enum('a','b')")).toBe('CAST(`c` AS CHAR) COLLATE utf8mb4_bin')
    expect(keyColumnExpr('`c`', "SET('a')")).toBe('CAST(`c` AS CHAR) COLLATE utf8mb4_bin')
    expect(keyColumnExpr('`c`', 'varchar(9)')).toBe('`c`')
  })
})
