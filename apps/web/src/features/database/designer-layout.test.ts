import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { autoLayout, boxColumns, drawnRelations } from './designer-layout.ts'

const rel = (table: string, refTable: string, extra: Partial<RelationDef> = {}): RelationDef => ({
  table,
  name: `fk_${table}_${refTable}`,
  columns: [`${refTable}_id`],
  refNamespace: { database: 'app' },
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
  ...extra,
})

describe('designer layout', () => {
  it('places a table one column right of the furthest table it references', () => {
    const relations = [rel('posts', 'users'), rel('comments', 'posts'), rel('comments', 'users')]
    const at = autoLayout(['comments', 'posts', 'users', 'tags'], relations)
    expect(at.users?.x).toBe(at.tags?.x)
    expect(at.posts?.x).toBeGreaterThan(at.users?.x ?? 0)
    expect(at.comments?.x).toBeGreaterThan(at.posts?.x ?? 0)
    // Two tables in one column do not overlap.
    expect(at.tags?.y).toBeGreaterThan(at.users?.y ?? 0)
  })

  it('terminates on a cycle and on a key to the table itself', () => {
    const relations = [rel('a', 'b'), rel('b', 'a'), rel('a', 'a')]
    const at = autoLayout(['a', 'b'], relations)
    expect(Object.keys(at)).toEqual(['a', 'b'])
  })

  it('lists key columns first, then referenced ones, once each', () => {
    const relations = [rel('posts', 'users'), rel('comments', 'posts', { columns: ['post_id'] })]
    expect(boxColumns('posts', relations)).toEqual(['users_id', 'id'])
  })

  it('draws only keys between tables on the diagram, in the same schema', () => {
    const ns = { database: 'app', schema: 'public' }
    const relations = [
      rel('posts', 'users', { refNamespace: { database: 'app', schema: 'public' } }),
      rel('posts', 'users', { name: 'elsewhere', refNamespace: { database: 'app', schema: 'audit' } }),
      rel('posts', 'missing', { refNamespace: { database: 'app', schema: 'public' } }),
    ]
    expect(drawnRelations(relations, 'postgres', ns, ['posts', 'users']).map((r) => r.name)).toEqual(['fk_posts_users'])
    // No schema in the URL is public, not "any schema".
    expect(drawnRelations(relations, 'postgres', { database: 'app' }, ['posts', 'users']).map((r) => r.name)).toEqual([
      'fk_posts_users',
    ])
    expect(drawnRelations([rel('posts', 'users')], 'mysql', { database: 'app' }, ['posts', 'users'])).toHaveLength(1)
    const elsewhere = rel('posts', 'users', { refNamespace: { database: 'other' } })
    expect(drawnRelations([elsewhere], 'mysql', { database: 'app' }, ['posts', 'users'])).toHaveLength(0)
  })
})
