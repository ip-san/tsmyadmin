import { describe, expect, it } from 'vitest'
import { quoteIdentifier, quoteLiteral } from './quote-identifier.ts'

describe('quoteIdentifier', () => {
  it('wraps a name in the quote character of the server', () => {
    expect(quoteIdentifier('mysql', 'users')).toBe('`users`')
    expect(quoteIdentifier('postgres', 'users')).toBe('"users"')
  })

  it('doubles the quote character inside the name, and only that one', () => {
    expect(quoteIdentifier('mysql', 'a`b"c')).toBe('`a``b"c`')
    expect(quoteIdentifier('postgres', 'a`b"c')).toBe('"a`b""c"')
  })

  it('keeps a name that is empty or has spaces, quoted', () => {
    expect(quoteIdentifier('mysql', '')).toBe('``')
    expect(quoteIdentifier('postgres', 'my table')).toBe('"my table"')
  })
})

describe('quoteLiteral', () => {
  it('wraps a text in single quotes and doubles the quotes inside it, on both servers', () => {
    expect(quoteLiteral('mysql', "it's")).toBe("'it''s'")
    expect(quoteLiteral('postgres', "it's")).toBe("'it''s'")
  })

  it('doubles a backslash on MySQL, where it escapes, and leaves it on PostgreSQL, where it does not', () => {
    expect(quoteLiteral('mysql', 'a\\b')).toBe("'a\\\\b'")
    expect(quoteLiteral('postgres', 'a\\b')).toBe("'a\\b'")
  })

  it('keeps a backslash before a quote from escaping the quote', () => {
    expect(quoteLiteral('mysql', "\\'")).toBe("'\\\\'''")
  })
})
