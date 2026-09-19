import { describe, expect, it } from 'vitest'
import { prefixRenames } from './TableBulkBar.tsx'

describe('prefixRenames', () => {
  it('adds a prefix to every name, and replaces or removes one only where a name starts with it', () => {
    expect(prefixRenames(['a', 'b'], 'x_')).toEqual([
      { from: 'a', to: 'x_a' },
      { from: 'b', to: 'x_b' },
    ])
    expect(prefixRenames(['old_a', 'b'], 'new_', 'old_')).toEqual([{ from: 'old_a', to: 'new_a' }])
    expect(prefixRenames(['old_a'], '', 'old_')).toEqual([{ from: 'old_a', to: 'a' }])
    expect(prefixRenames(['x_a'], 'x_', 'x_')).toEqual([])
  })
})
