import { describe, expect, it } from 'vitest'
import { safeJson } from './saved-items.ts'

describe('safeJson', () => {
  it('parses valid JSON', () => {
    expect(safeJson('{"a":[1,2]}')).toEqual({ a: [1, 2] })
  })

  it('reads a body that does not parse as null instead of throwing', () => {
    expect(safeJson('{not json')).toBeNull()
    expect(safeJson('')).toBeNull()
  })
})
