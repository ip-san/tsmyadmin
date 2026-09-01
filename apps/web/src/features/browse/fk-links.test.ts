import type { BrowseResult, ForeignKeyDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { fkTarget, linkableForeignKeys } from './fk-links.ts'

const fk = (over: Partial<ForeignKeyDef> = {}): ForeignKeyDef => ({
  name: 'fk',
  columns: ['user_id'],
  refNamespace: { database: 'shop' },
  refTable: 'users',
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
  ...over,
})

describe('linkableForeignKeys', () => {
  it('indexes single-column keys and skips composite ones', () => {
    const result = {
      foreignKeys: [fk(), fk({ name: 'c', columns: ['a', 'b'], refColumns: ['x', 'y'] })],
    } as BrowseResult
    expect([...linkableForeignKeys(result).keys()]).toEqual(['user_id'])
  })
})

describe('fkTarget', () => {
  it('builds an eq filter on the referenced column, keeping the PG schema', () => {
    expect(fkTarget(fk({ refNamespace: { database: 'shop', schema: 'app' } }), 7, 'shop')).toEqual({
      db: 'shop',
      schema: 'app',
      table: 'users',
      filters: JSON.stringify([{ column: 'id', op: 'eq', value: 7 }]),
    })
  })

  it('returns null for NULL and binary values', () => {
    expect(fkTarget(fk(), null, 'shop')).toBeNull()
    expect(fkTarget(fk(), { $bin: 'AA==' }, 'shop')).toBeNull()
  })
})
