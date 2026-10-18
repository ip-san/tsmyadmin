import type { Namespace, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { tableRole } from './table-role.ts'

type Shape = Pick<TableSchema, 'name' | 'primaryKey' | 'foreignKeys' | 'referencedBy'>
const HOME: Namespace = { database: 'shop' }
const home = (ns: Namespace) => ns.database === 'shop' && ns.schema === undefined
const fk = (columns: string[], refTable: string, refNamespace: Namespace = HOME) =>
  ({
    name: `fk_${refTable}`,
    columns,
    refNamespace,
    refTable,
    refColumns: ['id'],
  }) as unknown as Shape['foreignKeys'][number]
const from = (fromTable: string, fromNamespace: Namespace = HOME) =>
  ({
    name: `fk_${fromTable}`,
    fromNamespace,
    fromTable,
    fromColumns: ['x_id'],
    columns: ['id'],
  }) as unknown as Shape['referencedBy'][number]
const shape = (primaryKey: string[], foreignKeys: Shape['foreignKeys'], referencedBy: Shape['referencedBy'] = []) => ({
  name: 'it',
  primaryKey,
  foreignKeys,
  referencedBy,
})

describe('tableRole', () => {
  it('calls a table whose key is two foreign keys a junction', () => {
    const tags = shape(['post_id', 'tag_id'], [fk(['post_id'], 'posts'), fk(['tag_id'], 'tags')])
    expect(tableRole(tags, home)).toEqual({ role: 'junction', refersTo: 2, referredBy: 0, self: false })
  })

  it('does not call it a junction when its key has a column of its own', () => {
    const lines = shape(['order_id', 'line_no'], [fk(['order_id'], 'orders'), fk(['product_id'], 'products')])
    expect(tableRole(lines, home).role).toBe('detail')
  })

  it('tells masters, details, the ones in the middle and the isolated apart', () => {
    expect(tableRole(shape(['id'], [], [from('orders'), from('orders')]), home)).toEqual({
      role: 'master',
      refersTo: 0,
      referredBy: 1,
      self: false,
    })
    expect(tableRole(shape(['id'], [fk(['user_id'], 'users')]), home).role).toBe('detail')
    expect(tableRole(shape(['id'], [fk(['user_id'], 'users')], [from('lines')]), home).role).toBe('middle')
    expect(tableRole(shape(['id'], []), home).role).toBe('isolated')
  })

  it('calls a table whose only key is to itself a tree, and does not count itself as another table', () => {
    // parent_id → it: the key of a tree; its own row refers to it as well.
    const tree = shape(['id'], [fk(['parent_id'], 'it')], [from('it')])
    expect(tableRole(tree, home)).toEqual({ role: 'tree', refersTo: 0, referredBy: 0, self: true })
    // A tree that also refers to another table is a detail of it, still marked as a tree.
    const both = shape(['id'], [fk(['parent_id'], 'it'), fk(['org_id'], 'orgs')], [from('it')])
    expect(tableRole(both, home)).toEqual({ role: 'detail', refersTo: 1, referredBy: 0, self: true })
  })

  it('counts the tables a table refers to once, however many keys go to one', () => {
    const twice = shape(['id'], [fk(['created_by'], 'users'), fk(['updated_by'], 'users')])
    expect(tableRole(twice, home).refersTo).toBe(1)
  })

  it('takes a table of its name in another database for another table, and two of one name for two', () => {
    const elsewhere = { database: 'archive' }
    const copy = shape(
      ['id'],
      [fk(['old_id'], 'it', elsewhere)],
      [from('it', elsewhere), from('lines'), from('lines', elsewhere)]
    )
    expect(tableRole(copy, home)).toEqual({ role: 'middle', refersTo: 1, referredBy: 3, self: false })
  })
})
