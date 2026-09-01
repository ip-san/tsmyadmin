import { describe, expect, it } from 'vitest'
import { cellLiteral } from './literal.ts'

describe('cellLiteral', () => {
  it('renders NULL, numbers and booleans per dialect', () => {
    expect(cellLiteral('mysql', null)).toBe('NULL')
    expect(cellLiteral('postgres', 42)).toBe('42')
    expect(cellLiteral('mysql', 1.5)).toBe('1.5')
    expect(cellLiteral('mysql', Number.NaN)).toBe('NULL')
    expect(cellLiteral('mysql', true)).toBe('1')
    expect(cellLiteral('postgres', false)).toBe('FALSE')
  })

  it('escapes strings so values can never break out of the literal', () => {
    expect(cellLiteral('mysql', "'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'")
    expect(cellLiteral('postgres', "'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'")
    expect(cellLiteral('mysql', "it's \\ ok")).toBe("'it''s \\\\ ok'")
    expect(cellLiteral('postgres', "it's \\ ok")).toBe("'it''s \\ ok'")
  })

  it('renders binary as hex per dialect', () => {
    expect(cellLiteral('mysql', { $bin: '3q2+7w==' })).toBe("X'deadbeef'")
    expect(cellLiteral('postgres', { $bin: '3q2+7w==' })).toBe("'\\xdeadbeef'::bytea")
    expect(cellLiteral('mysql', { $bin: '' })).toBe("X''")
  })
})
