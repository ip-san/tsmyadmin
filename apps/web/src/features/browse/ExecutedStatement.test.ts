import { describe, expect, it } from 'vitest'
import { formatBoundValue } from './ExecutedStatement.tsx'

describe('formatBoundValue', () => {
  it('marks each kind of value so NULL, a number and a string cannot be confused', () => {
    expect(formatBoundValue(null)).toBe('NULL')
    expect(formatBoundValue('NULL')).toBe("'NULL'")
    expect(formatBoundValue(7)).toBe('7')
    expect(formatBoundValue('7')).toBe("'7'")
    expect(formatBoundValue(true)).toBe('true')
  })

  it('does not print binary contents, and shows a cut text as cut', () => {
    expect(formatBoundValue({ $bin: 'AAEC' })).not.toContain('AAEC')
    expect(formatBoundValue({ $text: 'abc', length: 10 })).toBe("'abc…'")
  })
})
