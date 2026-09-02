import { describe, expect, it } from 'vitest'
import { nextSort } from './sort.ts'

describe('nextSort', () => {
  it('cycles a single column asc → desc → none and replaces other columns', () => {
    expect(nextSort([], 'a')).toBe('a:asc')
    expect(nextSort([{ column: 'a', direction: 'asc' }], 'a')).toBe('a:desc')
    expect(nextSort([{ column: 'a', direction: 'desc' }], 'a')).toBeUndefined()
    expect(nextSort([{ column: 'b', direction: 'desc' }], 'a')).toBe('a:asc')
  })

  it('shift-click keeps the other columns in place', () => {
    const cur = [
      { column: 'a', direction: 'asc' as const },
      { column: 'b', direction: 'desc' as const },
    ]
    expect(nextSort(cur, 'c', true)).toBe('a:asc,b:desc,c:asc')
    expect(nextSort(cur, 'a', true)).toBe('a:desc,b:desc')
    expect(nextSort([{ column: 'a', direction: 'desc' }, cur[1] as (typeof cur)[1]], 'a', true)).toBe('b:desc')
  })
})
