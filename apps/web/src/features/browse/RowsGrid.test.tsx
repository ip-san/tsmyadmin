import type { BrowseResult } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { visibleColumns } from './RowsGrid.tsx'

const base: BrowseResult = {
  columns: [
    { name: 'id', dataType: 'int4' },
    { name: 'ctid', dataType: 'tid' },
  ],
  rows: [[1, '(0,1)']],
  truncated: false,
  total: 1,
  approximate: false,
  foreignKeys: [],
  keyKind: 'ctid',
  keyColumns: ['ctid'],
}

describe('visibleColumns', () => {
  it('hides the trailing ctid key column for PostgreSQL tables without a primary key', () => {
    expect(visibleColumns(base).map((c) => c.name)).toEqual(['id'])
    expect(visibleColumns({ ...base, keyKind: 'pk', keyColumns: ['id'] }).map((c) => c.name)).toEqual(['id', 'ctid'])
  })
})
