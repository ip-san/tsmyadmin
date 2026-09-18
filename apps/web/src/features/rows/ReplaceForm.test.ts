import { describe, expect, it } from 'vitest'
import { replaceableColumns } from './ReplaceForm.tsx'

describe('replaceableColumns', () => {
  it('offers text columns only, and never a generated one', () => {
    expect(
      replaceableColumns([
        { name: 'id', dataType: 'int', extra: 'auto_increment' },
        { name: 'name', dataType: 'varchar(100)', extra: '' },
        { name: 'note', dataType: 'text', extra: '' },
        { name: 'code', dataType: 'character varying(20)', extra: '' },
        { name: 'upper_name', dataType: 'varchar(100)', extra: 'STORED GENERATED' },
        { name: 'photo', dataType: 'blob', extra: '' },
      ])
    ).toEqual(['name', 'note', 'code'])
  })
})
