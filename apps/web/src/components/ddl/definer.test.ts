import { describe, expect, it } from 'vitest'
import { parseDefiner } from './definer.ts'

describe('parseDefiner', () => {
  it('splits at the last @ and strips the quotes SHOW GRANTS prints', () => {
    expect(parseDefiner('app@%')).toEqual({ user: 'app', host: '%' })
    expect(parseDefiner("'app'@'%'")).toEqual({ user: 'app', host: '%' })
    expect(parseDefiner('`a@b`@`10.0.0.1`')).toEqual({ user: 'a@b', host: '10.0.0.1' })
  })

  it('reads blank as none and refuses a missing host or user', () => {
    expect(parseDefiner('  ')).toBeNull()
    expect(parseDefiner('app@')).toBe('invalid')
    expect(parseDefiner("''@'%'")).toBe('invalid')
  })
})
