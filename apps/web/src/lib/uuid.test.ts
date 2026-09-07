import { describe, expect, it, vi } from 'vitest'
import { newQueryId } from './uuid.ts'

describe('newQueryId', () => {
  it('produces a v4 UUID with and without crypto.randomUUID', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(newQueryId()).toMatch(v4)
    const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never)
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    expect(newQueryId()).toMatch(v4)
    spy.mockRestore()
  })
})
