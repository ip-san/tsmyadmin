import { describe, expect, it } from 'vitest'
import { implicitRelations, type TableShape } from './implicit-relations.ts'

const ns = { database: 'shop' }
const table = (name: string, columns: string[], primaryKey = ['id']): TableShape => ({ name, columns, primaryKey })

describe('implicitRelations', () => {
  const tables = [
    table('users', ['id', 'name']),
    table('categories', ['id']),
    table('boxes', ['id']),
    table('orders', ['id', 'user_id', 'category_id', 'coupon_id', 'box_id']),
    table('Posts', ['id', 'USER_ID', 'parent_id']),
    table('tags', ['code'], ['code', 'lang']),
    table('notes', ['id', 'tag_id']),
  ]
  const found = (keys: { table: string; columns: string[] }[] = []) =>
    implicitRelations(tables, keys, ns).map((r) => `${r.table}.${r.columns[0]} → ${r.refTable}.${r.refColumns[0]}`)

  it('finds <name>_id columns to the table of that name or its plural, by its primary key', () => {
    expect(found()).toEqual([
      'orders.user_id → users.id',
      'orders.category_id → categories.id',
      'orders.box_id → boxes.id',
      'Posts.USER_ID → users.id',
    ])
  })

  it('leaves out a column named for its own table, and prefers the name itself to its plural', () => {
    const own = [table('user', ['id', 'user_id']), table('users', ['id']), table('logs', ['id', 'user_id'])]
    expect(implicitRelations(own, [], ns).map((r) => `${r.table}.${r.columns[0]} → ${r.refTable}`)).toEqual([
      'logs.user_id → user',
    ])
  })

  it('leaves out a column a foreign key already holds', () => {
    expect(found([{ table: 'orders', columns: ['user_id'] }])).not.toContain('orders.user_id → users.id')
  })

  it('leaves out a name with no table, and a table whose primary key is not one column', () => {
    // coupon_id: no coupons table; tag_id: tags has a key of two columns; parent_id: no parents table.
    expect(found().some((f) => /coupon|tag_id|parent/.test(f))).toBe(false)
  })

  it('names candidates so they cannot be taken for a key of the database', () => {
    const [first] = implicitRelations(tables, [], ns)
    expect(first?.name).toBe('?user_id')
    expect(first?.refNamespace).toEqual(ns)
  })
})
