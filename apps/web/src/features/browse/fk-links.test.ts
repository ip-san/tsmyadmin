import type { BrowseResult, ForeignKeyDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { fkTarget, linkableForeignKeys, linkableReverseKeys, reverseTarget } from './fk-links.ts'

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

describe('reverse references', () => {
  const ref = {
    name: 'fk_posts_user',
    fromNamespace: { database: 'shop' },
    fromTable: 'posts',
    fromColumns: ['user_id'],
    columns: ['id'],
  }
  it('indexes single-column reverse keys by referenced column', () => {
    const result = {
      referencedBy: [ref, { ...ref, name: 'c', columns: ['a', 'b'], fromColumns: ['x', 'y'] }],
    } as unknown as BrowseResult
    expect([...linkableReverseKeys(result).keys()]).toEqual(['id'])
  })
  it('targets the referencing table filtered by the FK column', () => {
    expect(reverseTarget(ref, 1, 'shop')).toEqual({
      db: 'shop',
      schema: undefined,
      table: 'posts',
      filters: JSON.stringify([{ column: 'user_id', op: 'eq', value: 1 }]),
    })
    expect(reverseTarget(ref, null, 'shop')).toBeNull()
  })
})
