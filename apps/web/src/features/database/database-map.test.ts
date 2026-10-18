import type { Namespace, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { databaseMap } from './database-map.ts'

const home = (ns: Namespace) => ns.database === 'shop' && ns.schema === undefined
const mapOf = (schemas: TableSchema[]) => databaseMap(schemas, home)
const table = (name: string, over: Partial<TableSchema> = {}): TableSchema => ({
  name,
  kind: 'table',
  comment: null,
  engine: null,
  rowEstimate: null,
  partitioned: false,
  hasChildren: false,
  inherits: [],
  collation: null,
  autoIncrement: null,
  columns: [],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  ...over,
})
const fk = (
  columns: string[],
  refTable: string,
  name = `fk_${refTable}`,
  refNamespace: Namespace = { database: 'shop' }
): TableSchema['foreignKeys'][number] => ({
  name,
  columns,
  refNamespace,
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
})
const from = (fromTable: string): TableSchema['referencedBy'][number] => ({
  name: `fk_${fromTable}`,
  fromNamespace: { database: 'shop' },
  fromTable,
  fromColumns: ['x_id'],
  columns: ['id'],
})
const index = (
  columns: string[],
  over: Partial<TableSchema['indexes'][number]> = {}
): TableSchema['indexes'][number] => ({
  name: `ix_${columns.join('_')}`,
  unique: false,
  primary: false,
  columns,
  type: null,
  predicate: null,
  definition: null,
  lengths: {},
  ...over,
})

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
    expect(map.roles.master).toEqual(['users'])
    expect(map.roles.middle).toEqual(['orders'])
    expect(map.roles.detail).toEqual(['lines'])
    expect(map.roles.isolated).toEqual(['audit', 'logs'])
    expect(map.roles.junction).toEqual([])
  })

  it('names the tables referred to most, the most first, ties by name, at most ten', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      table(`t${String(i).padStart(2, '0')}`, { referencedBy: [from('a')] })
    )
    const map = mapOf([
      table('zed', { referencedBy: [from('a'), from('b')] }),
      table('alpha', { referencedBy: [from('a'), from('b')] }),
      table('three', { referencedBy: [from('a'), from('b'), from('c'), from('c')] }),
      ...many,
    ])
    expect(map.hubs.slice(0, 3)).toEqual([
      { table: 'three', referredBy: 3 },
      { table: 'alpha', referredBy: 2 },
      { table: 'zed', referredBy: 2 },
    ])
    expect(map.hubs).toHaveLength(10)
  })

  it('does not count a table referring to itself as referred to', () => {
    const map = mapOf([
      table('categories', { foreignKeys: [fk(['parent_id'], 'categories')], referencedBy: [from('categories')] }),
    ])
    expect(map.hubs).toEqual([])
    expect(map.roles.tree).toEqual(['categories'])
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
    expect(map.unindexedKeys).toHaveLength(1)
  })

  it('does not take a partial, full-text or spatial index for one a join can use', () => {
    const map = mapOf([
      table('t', {
        indexes: [
          index(['a'], { predicate: 'deleted_at IS NULL' }),
          index(['b'], { type: 'FULLTEXT' }),
          index(['c'], { type: 'SPATIAL' }),
          index(['d'], { type: 'BTREE' }),
        ],
        foreignKeys: [fk(['a'], 'ra'), fk(['b'], 'rb'), fk(['c'], 'rc'), fk(['d'], 'rd')],
      }),
    ])
    expect(map.unindexedKeys.map((k) => k.refTable)).toEqual(['ra', 'rb', 'rc'])
  })

  it('calls a table whose key is two foreign keys a junction', () => {
    const map = mapOf([
      table('post_tags', {
        primaryKey: ['post_id', 'tag_id'],
        foreignKeys: [fk(['post_id'], 'posts'), fk(['tag_id'], 'tags')],
      }),
    ])
    expect(map.roles.junction).toEqual(['post_tags'])
  })

  it('takes a key to a table of its own name in another schema for a key to another table', () => {
    const map = mapOf([
      table('users', { foreignKeys: [fk(['id'], 'users', 'fk', { database: 'shop', schema: 'audit' })] }),
    ])
    expect(map.roles.detail).toEqual(['users'])
    expect(map.roles.tree).toEqual([])
  })
})
