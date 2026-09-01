import type { ColumnDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { conditionsToFilters, filtersToConditions } from './SearchForm.tsx'

const col = (name: string): ColumnDef => ({
  name,
  dataType: 'int',
  nullable: true,
  default: null,
  extra: '',
  comment: null,
  collation: null,
})

describe('search conditions', () => {
  it('builds filters in column order, dropping empty and value-less operators', () => {
    const filters = conditionsToFilters([col('a'), col('b'), col('c')], {
      c: { op: 'is_null', value: 'ignored' },
      a: { op: 'gt', value: '30' },
      b: { op: '', value: 'x' },
    })
    expect(filters).toEqual([
      { column: 'a', op: 'gt', value: '30' },
      { column: 'c', op: 'is_null' },
    ])
  })

  it('round-trips filters back into conditions', () => {
    expect(
      filtersToConditions([
        { column: 'a', op: 'like', value: 'A%' },
        { column: 'b', op: 'is_not_null' },
      ])
    ).toEqual({
      a: { op: 'like', value: 'A%' },
      b: { op: 'is_not_null', value: '' },
    })
  })
})
