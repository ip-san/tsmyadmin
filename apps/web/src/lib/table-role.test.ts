import { describe, expect, it } from 'vitest'
import { fk, from, inShop, table } from '@/test/schema-fixtures.ts'
import { tableRole } from './table-role.ts'

const ARCHIVE = { database: 'archive' }
const role = (...args: Parameters<typeof table>) => tableRole(table(...args), inShop)

describe('tableRole', () => {
  it('calls a table whose key is two foreign keys a junction', () => {
    const tags = { primaryKey: ['post_id', 'tag_id'], foreignKeys: [fk(['post_id'], 'posts'), fk(['tag_id'], 'tags')] }
    expect(role('post_tags', tags)).toEqual({ role: 'junction', refersTo: 2, referredBy: 0, self: false })
  })

  it('does not call it a junction when its key has a column of its own', () => {
    const lines = {
      primaryKey: ['order_id', 'line_no'],
      foreignKeys: [fk(['order_id'], 'orders'), fk(['product_id'], 'products')],
    }
    expect(role('lines', lines).role).toBe('detail')
  })

  it('does not call it a junction with one foreign key, or a key of one column', () => {
    // A key of two columns, one key: lines of one order.
    expect(role('lines', { primaryKey: ['order_id', 'no'], foreignKeys: [fk(['order_id'], 'orders')] }).role).toBe(
      'detail'
    )
    // A one-to-one extension of users: its key is the key to users.
    const profile = { primaryKey: ['user_id'], foreignKeys: [fk(['user_id'], 'users'), fk(['user_id'], 'accounts')] }
    expect(role('profiles', profile).role).toBe('detail')
    // One key of two columns that is its primary key: a one-to-one extension too.
    expect(role('ext', { primaryKey: ['a', 'b'], foreignKeys: [fk(['a', 'b'], 'pairs')] }).role).toBe('detail')
  })

  it('tells masters, details, the ones in the middle and the isolated apart, by what they count', () => {
    expect(role('users', { referencedBy: [from('orders'), from('orders')] })).toEqual({
      role: 'master',
      refersTo: 0,
      referredBy: 1,
      self: false,
    })
    expect(role('orders', { foreignKeys: [fk(['user_id'], 'users')] })).toEqual({
      role: 'detail',
      refersTo: 1,
      referredBy: 0,
      self: false,
    })
    expect(role('orders', { foreignKeys: [fk(['user_id'], 'users')], referencedBy: [from('lines')] })).toEqual({
      role: 'middle',
      refersTo: 1,
      referredBy: 1,
      self: false,
    })
    expect(role('logs')).toEqual({ role: 'isolated', refersTo: 0, referredBy: 0, self: false })
  })

  it('calls a table whose only key is to itself a tree, and does not count itself as another table', () => {
    // parent_id → it: the key of a tree; its own row refers to it as well.
    const tree = { foreignKeys: [fk(['parent_id'], 'it')], referencedBy: [from('it')] }
    expect(role('it', tree)).toEqual({ role: 'tree', refersTo: 0, referredBy: 0, self: true })
    // A tree that also refers to another table is a detail of it, still marked as a tree.
    const both = { foreignKeys: [fk(['parent_id'], 'it'), fk(['org_id'], 'orgs')], referencedBy: [from('it')] }
    expect(role('it', both)).toEqual({ role: 'detail', refersTo: 1, referredBy: 0, self: true })
  })

  it('calls a tree that others refer to a master, still marked as a tree', () => {
    const categories = {
      foreignKeys: [fk(['parent_id'], 'categories')],
      referencedBy: [from('categories'), from('products')],
    }
    expect(role('categories', categories)).toEqual({ role: 'master', refersTo: 0, referredBy: 1, self: true })
  })

  it('counts the tables a table refers to once, however many keys go to one', () => {
    const twice = { foreignKeys: [fk(['created_by'], 'users'), fk(['updated_by'], 'users')] }
    expect(role('posts', twice).refersTo).toBe(1)
  })

  it('takes a table of its name in another database for another table, and two of one name for two', () => {
    const copy = {
      foreignKeys: [fk(['old_id'], 'it', { refNamespace: ARCHIVE })],
      referencedBy: [from('it', { fromNamespace: ARCHIVE }), from('lines'), from('lines', { fromNamespace: ARCHIVE })],
    }
    expect(role('it', copy)).toEqual({ role: 'middle', refersTo: 1, referredBy: 3, self: false })
    // Two schemas of one database: two tables.
    const schemas = {
      referencedBy: [
        from('lines', { fromNamespace: { database: 'shop', schema: 'a' } }),
        from('lines', { fromNamespace: { database: 'shop', schema: 'b' } }),
      ],
    }
    expect(role('it', schemas).referredBy).toBe(2)
  })
})
