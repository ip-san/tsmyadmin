import { describe, expect, it } from 'vitest'
import { isProtectedDatabase } from './system-databases.ts'

describe('isProtectedDatabase', () => {
  it('protects catalogs and the connected PostgreSQL database', () => {
    expect(isProtectedDatabase('mysql', 'mysql', undefined)).toBe(true)
    expect(isProtectedDatabase('mysql', 'Performance_Schema', undefined)).toBe(true)
    expect(isProtectedDatabase('mysql', 'shop', 'shop')).toBe(false)
    expect(isProtectedDatabase('postgres', 'postgres', 'app')).toBe(true)
    expect(isProtectedDatabase('postgres', 'app', 'app')).toBe(true)
    expect(isProtectedDatabase('postgres', 'other', 'app')).toBe(false)
  })
})
