import { describe, expect, it } from 'vitest'
import { indexSort } from './IndexSort.tsx'

describe('indexSort', () => {
  it('sorts by every column of the index one way, and not by an expression part', () => {
    expect(indexSort(['a', 'b'], 'desc')).toEqual([
      { column: 'a', direction: 'desc' },
      { column: 'b', direction: 'desc' },
    ])
    expect(indexSort(['(lower(a))'], 'asc')).toBeNull()
    expect(indexSort([], 'asc')).toBeNull()
  })
})
