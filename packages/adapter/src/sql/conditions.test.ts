import type { Dialect, Filter, RowKey } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import {
  bitLiteral,
  buildKeyWhere,
  buildWhere,
  type ConditionHooks,
  conditionSql,
  TEXT_OPS,
  writeValue,
} from './conditions.ts'
import { Params } from './quote.ts'

/** The hooks of an adapter that adds nothing: a key value compared as it is. */
const plain = (dialect: Dialect): ConditionHooks => ({
  dialect,
  keyParam: (placeholder) => placeholder,
  keyMatchExpr: (expr) => expr,
  nullSafeEq: () => (dialect === 'mysql' ? '<=>' : 'IS NOT DISTINCT FROM'),
})
/** The hooks of an adapter whose placeholders reach the server untyped (MySQL): a value is cast to the column's type. */
const casting: ConditionHooks = {
  ...plain('mysql'),
  keyParam: (placeholder, type) => (type ? `CAST(${placeholder} AS ${type.toUpperCase()})` : placeholder),
  keyMatchExpr: (expr, type) => (type ? `BINARY ${expr}` : expr),
}
/** A bind that shows the value, so a test can read what was bound where. */
const bind = (v: unknown) => `<${String(v)}>`
const cond = (hooks: ConditionHooks, f: Partial<Filter> & { op: Filter['op'] }, type = '') =>
  conditionSql(hooks, '`c`', { column: 'c', ...f } as Filter, type, bind)

describe('conditionSql', () => {
  it("compares with the column's own type through the dialect's hook, and not otherwise", () => {
    expect(cond(plain('mysql'), { op: 'eq', value: 'v' }, 'int')).toBe('`c` = <v>')
    expect(cond(casting, { op: 'eq', value: 'v' }, 'int')).toBe('`c` = CAST(<v> AS INT)')
    expect(cond(casting, { op: 'in', values: ['a', 'b'] }, 'float')).toBe(
      '`c` IN (CAST(<a> AS FLOAT), CAST(<b> AS FLOAT))'
    )
    expect(cond(casting, { op: 'between', values: ['a', 'b'] }, 'float')).toBe(
      '`c` BETWEEN CAST(<a> AS FLOAT) AND CAST(<b> AS FLOAT)'
    )
    expect(cond(casting, { op: 'not_between', values: ['a', 'b'] })).toBe('`c` NOT BETWEEN <a> AND <b>')
    // Text matching never casts to the column's type.
    expect(cond(casting, { op: 'like', value: 'v' }, 'int')).toBe('`c` LIKE <v>')
  })

  it('needs no value for IS NULL, and reads the text form of an empty check', () => {
    expect(cond(plain('mysql'), { op: 'is_null' })).toBe('`c` IS NULL')
    expect(cond(plain('postgres'), { op: 'is_not_null' })).toBe('`c` IS NOT NULL')
    // MySQL: CONCAT keeps NULL as NULL and gives an INT its text ('0'); PostgreSQL has no implicit cast for it.
    expect(cond(plain('mysql'), { op: 'empty' }, 'int')).toBe("CONCAT(`c`) = ''")
    expect(cond(plain('mysql'), { op: 'not_empty' })).toBe("CONCAT(`c`) <> ''")
    expect(cond(plain('postgres'), { op: 'empty' }, 'int')).toBe("`c`::text = ''")
  })

  it("matches the user's text literally: LIKE metacharacters escaped, wildcards added here", () => {
    expect(cond(plain('mysql'), { op: 'contains', value: '50%_off!' })).toBe("`c` LIKE <%50!%!_off!!%> ESCAPE '!'")
    expect(cond(plain('mysql'), { op: 'starts_with', value: 'a_b' })).toBe("`c` LIKE <a!_b%> ESCAPE '!'")
    expect(cond(plain('postgres'), { op: 'contains', value: 'x' })).toBe("`c`::text LIKE <%x%> ESCAPE '!'")
    // A LIKE pattern the user wrote is theirs: not escaped.
    expect(cond(plain('mysql'), { op: 'not_like', value: 'a%' })).toBe('`c` NOT LIKE <a%>')
  })

  it('spells a regular expression per dialect', () => {
    expect(cond(plain('mysql'), { op: 'regexp', value: '^a' })).toBe('`c` REGEXP <^a>')
    expect(cond(plain('mysql'), { op: 'not_regexp', value: '^a' })).toBe('`c` NOT REGEXP <^a>')
    expect(cond(plain('postgres'), { op: 'regexp', value: '^a' })).toBe('`c`::text ~ <^a>')
    expect(cond(plain('postgres'), { op: 'not_regexp', value: '^a' })).toBe('`c`::text !~ <^a>')
  })

  it('refuses a filter that lacks what its operator needs', () => {
    expect(() => cond(plain('mysql'), { op: 'between', values: ['a', 'b', 'c'] })).toThrowError(
      'Filter "between" on c takes two values'
    )
    expect(() => cond(plain('mysql'), { op: 'in', values: [] })).toThrowError(
      'Filter "in" on c takes at least one value'
    )
    expect(() => cond(plain('mysql'), { op: 'eq' })).toThrowError('Filter "eq" on c requires a value')
  })
})

describe('buildWhere', () => {
  it('is empty without filters', () => {
    expect(buildWhere(plain('mysql'), [], new Params('mysql'), new Map())).toBe('')
  })

  it('joins the conditions with AND, binding each value as a placeholder in order', () => {
    const filters: Filter[] = [
      { column: 'a', op: 'eq', value: 1 },
      { column: 'b', op: 'contains', value: 'x_y' },
      { column: 'c', op: 'between', values: [1, 2] },
    ]
    const types = new Map([
      ['a', 'int'],
      ['c', 'float'],
    ])
    const mysql = new Params('mysql')
    expect(buildWhere(casting, filters, mysql, types)).toBe(
      " WHERE `a` = CAST(? AS INT) AND `b` LIKE ? ESCAPE '!' AND `c` BETWEEN CAST(? AS FLOAT) AND CAST(? AS FLOAT)"
    )
    expect(mysql.values).toEqual([1, '%x!_y%', 1, 2])
    const pg = new Params('postgres')
    expect(buildWhere(plain('postgres'), filters, pg, types)).toBe(
      ' WHERE "a" = $1 AND "b"::text LIKE $2 ESCAPE \'!\' AND "c" BETWEEN $3 AND $4'
    )
    expect(pg.values).toEqual([1, '%x!_y%', 1, 2])
  })
})

describe('buildKeyWhere', () => {
  const pk: RowKey = { kind: 'pk', values: { id: 1, code: 'x' } }

  it('matches a primary key column by column, each value typed by the hook', () => {
    const params = new Params('mysql')
    expect(buildKeyWhere(casting, pk, params, new Map([['id', 'int']]))).toBe(
      ' WHERE `id` = CAST(? AS INT) AND `code` = ?'
    )
    expect(params.values).toEqual([1, 'x'])
    expect(() =>
      buildKeyWhere(plain('mysql'), { kind: 'pk', values: {} }, new Params('mysql'), new Map())
    ).toThrowError('Primary key values are empty')
  })

  it('matches every column exactly, NULL included, where a row has no key (MySQL only)', () => {
    const key: RowKey = { kind: 'all-columns', values: { a: 1, b: null } }
    const params = new Params('mysql')
    expect(buildKeyWhere(casting, key, params, new Map([['a', 'json']]))).toBe(
      ' WHERE BINARY `a` <=> BINARY CAST(? AS JSON) AND `b` <=> ?'
    )
    expect(params.values).toEqual([1, null])
    expect(() => buildKeyWhere(plain('postgres'), key, new Params('postgres'), new Map())).toThrowError(
      'all-columns keys are only supported on MySQL'
    )
    expect(() =>
      buildKeyWhere(plain('mysql'), { kind: 'all-columns', values: {} }, new Params('mysql'), new Map())
    ).toThrowError('Key values are empty')
  })

  it('addresses a PostgreSQL row by ctid (PostgreSQL only)', () => {
    const key: RowKey = { kind: 'ctid', value: '(0,1)' }
    const params = new Params('postgres')
    expect(buildKeyWhere(plain('postgres'), key, params, new Map())).toBe(' WHERE ctid = $1::tid')
    expect(params.values).toEqual(['(0,1)'])
    expect(() => buildKeyWhere(plain('mysql'), key, new Params('mysql'), new Map())).toThrowError(
      'ctid keys are only supported on PostgreSQL'
    )
  })
})

describe('writeValue', () => {
  it('binds a value, and an allowed function around its bound argument', () => {
    const mysql = new Params('mysql')
    expect(writeValue('mysql', mysql, 5)).toBe('?')
    expect(writeValue('mysql', mysql, { $fn: 'md5', arg: 'abc' })).toBe('MD5(?)')
    expect(writeValue('mysql', mysql, { $fn: 'now' })).toBe('NOW()')
    expect(mysql.values).toEqual([5, 'abc'])
    const pg = new Params('postgres')
    expect(writeValue('postgres', pg, { $fn: 'md5', arg: 'abc' })).toBe('md5($1::text)')
  })

  it('refuses a function the dialect lacks, and one that is not on the list', () => {
    expect(() => writeValue('postgres', new Params('postgres'), { $fn: 'sha1', arg: 'x' })).toThrowError(
      'sha1 is not available on postgres'
    )
    expect(() => writeValue('mysql', new Params('mysql'), { $fn: 'drop' } as never)).toThrowError(
      'drop is not available on mysql'
    )
  })
})

describe('bitLiteral', () => {
  it('writes a whole number as the hex literal of its bytes', () => {
    expect(bitLiteral(170)).toBe("X'aa'")
    expect(bitLiteral(0)).toBe("X'00'")
    expect(bitLiteral('256')).toBe("X'0100'")
    expect(bitLiteral('18446744073709551615')).toBe("X'ffffffffffffffff'")
  })

  it('refuses what a BIT column cannot hold, rather than letting MySQL clamp it', () => {
    for (const bad of ['18446744073709551616', '-1', '1.5', 'abc', '']) {
      expect(() => bitLiteral(bad)).toThrowError('A BIT value must be a whole number')
    }
  })
})

describe('TEXT_OPS', () => {
  it('names the operators that match on the text form', () => {
    expect([...TEXT_OPS].sort()).toEqual(['contains', 'like', 'not_like', 'not_regexp', 'regexp', 'starts_with'])
  })
})
