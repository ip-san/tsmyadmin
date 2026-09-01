import type { BrowseResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { rowKeyFor, rowToValues } from './row-key.ts'

const base = (over: Partial<BrowseResult>): BrowseResult => ({
  columns: [
    { name: 'a', dataType: 'int' },
    { name: 'b', dataType: 'varchar' },
  ],
  rows: [],
  truncated: false,
  total: 0,
  approximate: false,
  foreignKeys: [],
  keyKind: 'pk',
  keyColumns: ['a'],
  ...over,
})

describe('rowKeyFor', () => {
  it('uses primary key columns', () => {
    expect(rowKeyFor(base({ keyColumns: ['a'] }), [1, 'x'])).toEqual({ kind: 'pk', values: { a: 1 } })
    expect(rowKeyFor(base({ keyColumns: ['a', 'b'] }), [1, 'x'])).toEqual({ kind: 'pk', values: { a: 1, b: 'x' } })
  })

  it('uses the hidden trailing ctid column', () => {
    const r = base({
      columns: [
        { name: 'a', dataType: 'int' },
        { name: 'ctid', dataType: 'tid' },
      ],
      keyKind: 'ctid',
      keyColumns: ['ctid'],
    })
    expect(rowKeyFor(r, [1, '(0,3)'])).toEqual({ kind: 'ctid', value: '(0,3)' })
    expect(rowToValues(r, [1, '(0,3)'])).toEqual({ a: 1 })
  })

  it('uses all columns (NULL included) but refuses binary values', () => {
    const r = base({ keyKind: 'all-columns', keyColumns: ['a', 'b'] })
    expect(rowKeyFor(r, [null, 'x'])).toEqual({ kind: 'all-columns', values: { a: null, b: 'x' } })
    expect(rowKeyFor(r, [1, { $bin: 'AA==' }])).toBeNull()
  })

  it('returns null for views', () => {
    expect(rowKeyFor(base({ keyKind: 'none', keyColumns: [] }), [1, 'x'])).toBeNull()
  })
})
