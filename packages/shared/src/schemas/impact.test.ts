import { describe, expect, it } from 'vitest'
import { DeleteImpactRequestSchema, deleteActionOf } from './impact.ts'

describe('deleteActionOf', () => {
  it.each([
    ['CASCADE', 'cascade'],
    ['SET NULL', 'setNull'],
    ['SET DEFAULT', 'setDefault'],
    ['RESTRICT', 'restrict'],
    ['NO ACTION', 'noAction'],
    ['cascade', 'cascade'],
  ] as const)('reads %s as %s', (rule, action) => {
    expect(deleteActionOf(rule)).toBe(action)
  })

  it('reads a key that reports no rule as NO ACTION', () => {
    expect(deleteActionOf(null)).toBe('noAction')
  })
})

describe('DeleteImpactRequestSchema', () => {
  const key = { kind: 'pk' as const, values: { id: 1 } }

  it('takes between one and a hundred keys', () => {
    expect(DeleteImpactRequestSchema.safeParse({ keys: [] }).success).toBe(false)
    expect(DeleteImpactRequestSchema.safeParse({ keys: [key] }).success).toBe(true)
    expect(DeleteImpactRequestSchema.safeParse({ keys: Array(101).fill(key) }).success).toBe(false)
  })
})
