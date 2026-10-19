import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { locale } from '@/config/locale-screens.ts'
import type { RoleGuess } from '@/lib/table-role.ts'
import { column, index, relation } from '@/test/schema-fixtures.ts'
import { tableTourScenes } from './table-tour.ts'

const t = locale.tableTour
const g = locale.tour

// orgs ← users ← orders ← lines; orders → products; logs on their own.
const toUsers = relation('orders', ['user_id'], 'users')
const toProducts = relation('orders', ['product_id'], 'products')
const fromLines = relation('lines', ['order_id'], 'orders')
const toOrgs = relation('users', ['org_id'], 'orgs')
const relations = [toUsers, toProducts, fromLines, toOrgs]
const tables = ['orders', 'users', 'products', 'lines', 'orgs', 'logs']
const middle: RoleGuess = { role: 'middle', refersTo: 2, referredBy: 1, self: false }
const orders = {
  name: 'orders',
  kind: 'table' as const,
  comment: '注文',
  columns: [column('id', 'int'), column('user_id', 'int'), column('product_id', 'int')],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
}

describe('tableTourScenes', () => {
  it('tells what the table is, its key, what it refers to and what refers to it, what is further, and the whole', () => {
    const scenes = tableTourScenes({ schema: orders, guess: middle, relations, tables })
    expect(scenes.map((s) => s.title)).toEqual([
      'orders',
      t.primaryKeyTitle,
      t.refersTitle(2),
      t.referredTitle(1),
      t.fartherTitle(1),
      t.endTitle,
    ])
    const [intro, key, refers, referred, farther, end] = scenes
    expect(intro?.text).toBe([t.roles.middle, t.columns(3), '注文'].join(g.stop))
    expect(intro?.overlay).toMatchObject({ enter: true })
    expect(intro?.frame).toEqual(['orders'])
    expect(key?.text).toBe(t.primaryKey('id'))
    expect(key?.overlay.columns.get('orders')).toEqual(new Set(['id']))

    expect(refers?.frame).toEqual(['orders', 'users', 'products'])
    expect(refers?.pulse).toEqual(['users', 'products'])
    expect([...(refers?.overlay.flow ?? [])]).toEqual([
      [relationKey(toUsers), 'forward'],
      [relationKey(toProducts), 'forward'],
    ])
    expect(refers?.text).toBe(
      `${t.refersText}${g.stop}${t.key('orders', 'user_id', 'users', 'id')}${g.and}${t.key('orders', 'product_id', 'products', 'id')}`
    )
    expect(referred?.frame).toEqual(['orders', 'lines'])
    expect(referred?.overlay.columns.get('lines')).toEqual(new Set(['order_id']))

    // orgs, through users: the way there lit, only the last key flowing.
    expect(farther?.pulse).toEqual(['orgs'])
    expect(farther?.overlay.tables.get('users')?.tone).toBe('index')
    expect([...(farther?.overlay.relations.keys() ?? [])]).toEqual([relationKey(toUsers), relationKey(toOrgs)])
    expect([...(farther?.overlay.flow?.keys() ?? [])]).toEqual([relationKey(toOrgs)])
    expect(farther?.frame).toEqual(expect.arrayContaining(['orders', 'users', 'products', 'lines', 'orgs']))
    expect(farther?.frame).not.toContain('logs')

    expect(end?.text).toBe(t.end(2, 1, 1))
    expect(end?.overlay).toMatchObject({ fade: false })
  })

  it('says there is no primary key, and leaves out what the table does not have', () => {
    const logs = {
      name: 'logs',
      kind: 'table' as const,
      comment: null,
      columns: [column('message', 'int')],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    }
    const scenes = tableTourScenes({
      schema: logs,
      guess: { role: 'isolated', refersTo: 0, referredBy: 0, self: false },
      relations,
      tables,
    })
    expect(scenes.map((s) => s.title)).toEqual(['logs', t.primaryKeyTitle, t.endTitle])
    expect(scenes[0]?.text).toBe([t.roles.isolated, t.columns(1)].join(g.stop))
    expect(scenes[1]?.text).toBe(t.noPrimaryKey)
    expect(scenes[1]?.overlay.tables.get('logs')).toEqual({ tone: 'blocked', badge: t.noPrimaryKeyBadge })
  })

  it('tells a key to itself on its own, not as a table it refers to', () => {
    const parent = relation('categories', ['parent_id'], 'categories')
    const scenes = tableTourScenes({
      schema: {
        name: 'categories',
        kind: 'table' as const,
        comment: null,
        columns: [column('id', 'int'), column('parent_id', 'int')],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      },
      guess: { role: 'tree', refersTo: 0, referredBy: 0, self: true },
      relations: [parent],
      tables: ['categories'],
    })
    expect(scenes.map((s) => s.title)).toEqual(['categories', t.primaryKeyTitle, t.selfTitle, t.endTitle])
    expect(scenes[2]?.overlay.columns.get('categories')).toEqual(new Set(['parent_id', 'id']))
    expect(scenes[2]?.text).toBe(`${t.selfText}${g.stop}${t.key('categories', 'parent_id', 'categories', 'id')}`)
  })

  it('says why it is so, from comments and keys, and where it may cost time', () => {
    const w = locale.designReading
    const cascade = relation('orders', ['user_id'], 'users', { onDelete: 'CASCADE' })
    const fromLinesSetNull = relation('lines', ['order_id'], 'orders', { onDelete: 'SET NULL' })
    const scenes = tableTourScenes({
      schema: {
        ...orders,
        columns: [
          column('id', 'int'),
          column('user_id', 'int', { nullable: false, comment: '注文した会員' }),
          column('created_at', 'timestamp'),
        ],
        primaryKey: [],
        indexes: [index(['created_at'])],
      },
      guess: middle,
      relations: [cascade, fromLinesSetNull],
      tables,
    })
    const [intro, , refers, referred] = scenes
    expect(intro?.notes).toEqual([w.history('created_at')])
    expect(intro?.hints).toEqual([w.noPrimaryKey('orders')])
    expect(refers?.notes).toEqual([
      w.columnComment('orders', 'user_id', '注文した会員'),
      w.oneToMany('orders', 'users'),
      w.required('orders', 'users'),
      w.lifecycle.cascade('orders', 'users'),
    ])
    expect(refers?.hints).toEqual([w.unindexed('orders', 'user_id', 'users')])
    // Another table's key: what a delete does is known; how many and a must are not, and nothing is said of them.
    expect(referred?.notes).toEqual([w.lifecycle.setNull('lines', 'orders')])
    expect(referred?.hints).toBeUndefined()
    expect(scenes.at(-1)?.notes).toEqual([w.parts([w.pair('orders', 'users')]), w.loose([w.pair('lines', 'orders')])])
  })
})
