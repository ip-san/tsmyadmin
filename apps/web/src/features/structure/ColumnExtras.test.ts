import { describe, expect, it } from 'vitest'
import { attributeOf, withAttribute } from './ColumnExtras.tsx'

describe('column attributes', () => {
  it('reads the attribute written in a type, and replaces or removes it', () => {
    expect(attributeOf('int unsigned')).toBe('UNSIGNED')
    expect(attributeOf('INT UNSIGNED ZEROFILL')).toBe('UNSIGNED ZEROFILL')
    expect(attributeOf('varbinary(10)')).toBe('')
    expect(attributeOf('varchar(10) binary')).toBe('BINARY')
    expect(withAttribute('int unsigned', 'UNSIGNED ZEROFILL')).toBe('int UNSIGNED ZEROFILL')
    expect(withAttribute('INT UNSIGNED ZEROFILL', '')).toBe('INT')
    expect(withAttribute('bigint', 'UNSIGNED')).toBe('bigint UNSIGNED')
  })
})
