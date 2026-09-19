import { describe, expect, it } from 'vitest'
import { isActiveProcess } from './processes.ts'

describe('isActiveProcess', () => {
  it('hides sleeping and idle connections but keeps the ones holding a transaction open', () => {
    expect(isActiveProcess({ state: 'Sleep' })).toBe(false)
    expect(isActiveProcess({ state: 'idle' })).toBe(false)
    expect(isActiveProcess({ state: 'Query' })).toBe(true)
    expect(isActiveProcess({ state: 'active' })).toBe(true)
    expect(isActiveProcess({ state: 'active (Lock: relation)' })).toBe(true)
    expect(isActiveProcess({ state: 'idle in transaction' })).toBe(true)
    expect(isActiveProcess({ state: null })).toBe(true)
  })
})
