import type { TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { fk, from, index, inShop, table } from '@/test/schema-fixtures.ts'
import { databaseMap } from './database-map.ts'

const mapOf = (schemas: TableSchema[]) => databaseMap(schemas, inShop)

describe('databaseMap', () => {
  it('sorts the tables into their roles, by name, and counts views apart', () => {
    const map = mapOf([
      table('users', { referencedBy: [from('orders')] }),
      table('orders', { foreignKeys: [fk(['user_id'], 'users')], referencedBy: [from('lines')] }),
      table('lines', { foreignKeys: [fk(['order_id'], 'orders')] }),
      table('logs'),
      table('audit'),
      table('active', { kind: 'view' }),
      table('totals', { kind: 'materialized_view' }),
      table('seq', { kind: 'sequence' }),
    ])
    expect(map.tables).toBe(5)
    expect(map.views).toBe(2)
    expect(map.roles).toEqual({
      master: ['users'],
      middle: ['orders'],
      detail: ['lines'],
      junction: [],
      tree: [],
      isolated: ['audit', 'logs'],
    })
  })

  it('puts a table whose key is two foreign keys among the junctions', () => {
    const map = mapOf([
      table('post_tags', {
        primaryKey: ['post_id', 'tag_id'],
        foreignKeys: [fk(['post_id'], 'posts'), fk(['tag_id'], 'tags')],
      }),
    ])
    expect(map.roles.junction).toEqual(['post_tags'])
  })

  it('has nothing in it for no tables, or views only', () => {
    const nothing = {
      tables: 0,
      views: 0,
      roles: { master: [], middle: [], detail: [], junction: [], tree: [], isolated: [] },
      hubs: [],
      noPrimaryKey: [],
      unindexedKeys: [],
    }
    expect(mapOf([])).toEqual(nothing)
    // A view's keys and indexes (a materialised view has indexes) are not looked at.
    const view = table('v', { kind: 'materialized_view', primaryKey: [], foreignKeys: [fk(['a'], 'r')] })
    expect(mapOf([view, table('s', { kind: 'sequence' })])).toEqual({ ...nothing, views: 1 })
  })

  it('names the tables referred to most, the most first, ties by name, at most ten', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      table(`t${String(i).padStart(2, '0')}`, { referencedBy: [from('a')] })
    )
    const map = mapOf([
      table('zed', { referencedBy: [from('a'), from('b')] }),
      table('alpha', { referencedBy: [from('a'), from('b')] }),
      table('three', { referencedBy: [from('a'), from('b'), from('c')] }),
      ...many,
    ])
    expect(map.hubs.slice(0, 3)).toEqual([
      { table: 'three', referredBy: 3 },
      { table: 'alpha', referredBy: 2 },
      { table: 'zed', referredBy: 2 },
    ])
    // Ten in all: of the twelve referred to once, the first seven by name.
    expect(map.hubs.map((h) => h.table).slice(3)).toEqual(['t00', 't01', 't02', 't03', 't04', 't05', 't06'])
  })

  it('counts a table referring by two keys as one', () => {
    const map = mapOf([table('users', { referencedBy: [from('posts'), from('posts', { name: 'fk_editor' })] })])
    expect(map.hubs).toEqual([{ table: 'users', referredBy: 1 }])
  })

  it('does not count a table referring to itself as referred to', () => {
    const map = mapOf([
      table('categories', { foreignKeys: [fk(['parent_id'], 'categories')], referencedBy: [from('categories')] }),
    ])
    expect(map.hubs).toEqual([])
    expect(map.roles.tree).toEqual(['categories'])
  })

  it('takes a key to a table of its own name in another schema for a key to another table', () => {
    const audit = { database: 'shop', schema: 'audit' }
    const map = mapOf([table('users', { foreignKeys: [fk(['id'], 'users', { refNamespace: audit })] })])
    expect(map.roles.detail).toEqual(['users'])
    expect(map.roles.tree).toEqual([])
  })

  it('lists the tables without a primary key, not the views', () => {
    const map = mapOf([table('logs', { primaryKey: [] }), table('v', { kind: 'view', primaryKey: [] }), table('users')])
    expect(map.noPrimaryKey).toEqual(['logs'])
  })

  it('lists the foreign keys no index or primary key starts with', () => {
    const map = mapOf([
      table('lines', {
        primaryKey: ['order_id', 'line_no'],
        indexes: [index(['b', 'a', 'c']), index(['x', 'y'])],
        foreignKeys: [
          fk(['order_id'], 'orders'), // the primary key starts with it
          fk(['a', 'b'], 'pairs'), // an index starts with both, in another order
          fk(['product_id'], 'products'), // no index
          fk(['y'], 'whys'), // an index has it second only
          fk(['x', 'z'], 'zeds'), // an index starts with one of the two only
          fk([], 'nothing'), // no columns (as a catalog may report): nothing to index
        ],
      }),
    ])
    expect(map.unindexedKeys.map((k) => k.refTable)).toEqual(['products', 'whys', 'zeds'])
    expect(map.unindexedKeys[0]).toEqual({
      table: 'lines',
      key: 'fk_products',
      columns: ['product_id'],
      refTable: 'products',
    })
  })

  it('takes a key on more columns than an index has as not indexed', () => {
    const map = mapOf([table('t', { indexes: [index(['a'])], foreignKeys: [fk(['a', 'b'], 'r')] })])
    expect(map.unindexedKeys.map((k) => k.refTable)).toEqual(['r'])
  })

  it('does not take a partial, full-text or spatial index for one a join can use, however the type is written', () => {
    const map = mapOf([
      table('t', {
        indexes: [
          index(['a'], { predicate: 'deleted_at IS NULL' }),
          index(['b'], { type: 'FULLTEXT' }),
          index(['c'], { type: 'spatial' }),
          index(['d'], { type: 'BTREE' }),
          // Names that only start or end like them are other types.
          index(['e'], { type: 'fulltext_ish' }),
          index(['f'], { type: 'nonspatial' }),
        ],
        foreignKeys: [
          fk(['a'], 'ra'),
          fk(['b'], 'rb'),
          fk(['c'], 'rc'),
          fk(['d'], 'rd'),
          fk(['e'], 're'),
          fk(['f'], 'rf'),
        ],
      }),
    ])
    expect(map.unindexedKeys.map((k) => k.refTable)).toEqual(['ra', 'rb', 'rc'])
  })
})
