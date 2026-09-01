import { describe, expect, it } from 'vitest'
import { Params, placeholder, quoteIdent, quoteTable } from './quote.ts'

describe('quoteIdent', () => {
  it('quotes and escapes for each dialect', () => {
    expect(quoteIdent('mysql', 'users')).toBe('`users`')
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`')
    expect(quoteIdent('postgres', 'users')).toBe('"users"')
    expect(quoteIdent('postgres', 'we"ird')).toBe('"we""ird"')
  })

  it('does not let injection payloads escape the identifier', () => {
    expect(quoteIdent('mysql', '`; DROP TABLE x; --')).toBe('```; DROP TABLE x; --`')
    expect(quoteIdent('postgres', '"; DROP TABLE x; --')).toBe('"""; DROP TABLE x; --"')
    expect(quoteIdent('postgres', 'a\\"b')).toBe('"a\\""b"')
  })

  it('rejects NUL bytes', () => {
    expect(() => quoteIdent('mysql', 'a\0b')).toThrow()
  })
})

describe('quoteTable', () => {
  it('qualifies with database (mysql) or schema (postgres, default public)', () => {
    expect(quoteTable('mysql', { database: 'db' }, 't')).toBe('`db`.`t`')
    expect(quoteTable('postgres', { database: 'db' }, 't')).toBe('"public"."t"')
    expect(quoteTable('postgres', { database: 'db', schema: 'app' }, 't')).toBe('"app"."t"')
  })
})

describe('placeholders', () => {
  it('renders ? for mysql and $n for postgres', () => {
    expect(placeholder('mysql', 3)).toBe('?')
    expect(placeholder('postgres', 3)).toBe('$3')
  })

  it('Params accumulates values in order', () => {
    const p = new Params('postgres')
    expect(p.add(1)).toBe('$1')
    expect(p.add('x')).toBe('$2')
    expect(p.values).toEqual([1, 'x'])
  })
})
