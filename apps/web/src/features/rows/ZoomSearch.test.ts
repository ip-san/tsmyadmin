import { describe, expect, it } from 'vitest'
import { plottableColumns, rangeFilters, rowFilters } from './zoom-rows.ts'

describe('zoom search', () => {
  it('offers the columns declared as numbers on both dialects', () => {
    const columns = [
      { name: 'id', dataType: 'int unsigned' },
      { name: 'price', dataType: 'decimal(10,2)' },
      { name: 'score', dataType: 'double precision' },
      { name: 'big', dataType: 'bigint' },
      { name: 'name', dataType: 'varchar(20)' },
      { name: 'wait', dataType: 'interval' },
      { name: 'at', dataType: 'point' },
      { name: 'created', dataType: 'timestamp with time zone' },
    ]
    expect(plottableColumns(columns)).toEqual(['id', 'price', 'score', 'big'])
  })

  it('finds a row again by its key, and gives up where the key cannot be typed back', () => {
    expect(rowFilters(['a', 'b'], ['b', 'x', 'a'], [2, 'v', '1'])).toEqual([
      { column: 'a', op: 'eq', value: '1' },
      { column: 'b', op: 'eq', value: 2 },
    ])
    expect(rowFilters([], ['a'], [1])).toBeNull()
    expect(rowFilters(['a'], ['a'], [null])).toBeNull()
    expect(rowFilters(['a'], ['a'], [{ $bin: 'AA==' }])).toBeNull()
  })
})

describe('rangeFilters', () => {
  it('limits an axis at either end or both, and not at all when empty', () => {
    expect(rangeFilters('n', ' 1 ', '5')).toEqual([{ column: 'n', op: 'between', values: ['1', '5'] }])
    expect(rangeFilters('n', '1', '')).toEqual([{ column: 'n', op: 'gte', value: '1' }])
    expect(rangeFilters('n', '', '5')).toEqual([{ column: 'n', op: 'lte', value: '5' }])
    expect(rangeFilters('n', ' ', '')).toEqual([])
  })
})
