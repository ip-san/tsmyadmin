import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, index, table } from '@/test/schema-fixtures.ts'
import {
  columnComments,
  designSummary,
  keyIntent,
  keyReading,
  keyTuning,
  lifecycleOf,
  named,
  shortComment,
  tableReading,
  tableTuning,
} from './design-reading.ts'

const w = locale.designReading

// order_items(order_id NOT NULL → orders ON DELETE CASCADE), its own id the key.
const items = table('order_items', {
  columns: [column('id', 'bigint', { nullable: false }), column('order_id', 'bigint', { nullable: false })],
  foreignKeys: [fk(['order_id'], 'orders', { onDelete: 'CASCADE' })],
})

describe('lifecycleOf', () => {
  it('reads what a delete does, whatever the case or spacing, and takes no action as refusing', () => {
    expect(lifecycleOf('CASCADE')).toBe('cascade')
    expect(lifecycleOf('set  null')).toBe('setNull')
    expect(lifecycleOf('SET DEFAULT')).toBe('setDefault')
    expect(lifecycleOf('RESTRICT')).toBe('restrict')
    expect(lifecycleOf('NO ACTION')).toBe('restrict')
    expect(lifecycleOf(null)).toBe('restrict')
  })
})

describe('keyIntent', () => {
  it('reads one to many, a must, and what a delete does from the referring table', () => {
    expect(keyIntent(items.foreignKeys[0] ?? fk([], ''), items)).toEqual({
      oneToOne: false,
      required: true,
      lifecycle: 'cascade',
    })
  })

  it('reads one to one from the primary key or a unique key of the key columns, not from a partial one', () => {
    const key = fk(['user_id'], 'users')
    const cols = [column('user_id', 'int')]
    expect(keyIntent(key, table('profiles', { columns: cols, primaryKey: ['user_id'] })).oneToOne).toBe(true)
    expect(
      keyIntent(key, table('payments', { columns: cols, indexes: [index(['user_id'], { unique: true })] })).oneToOne
    ).toBe(true)
    const partial = index(['user_id'], { unique: true, predicate: 'deleted_at IS NULL' })
    expect(keyIntent(key, table('p', { columns: cols, indexes: [partial] })).oneToOne).toBe(false)
    expect(keyIntent(key, table('p', { columns: cols })).required).toBe(false)
  })

  it('says nothing of how many or a must without the definition, nor of a must for a column it does not list', () => {
    expect(keyIntent(fk(['a'], 'b', { onDelete: 'SET NULL' }))).toEqual({
      oneToOne: undefined,
      required: undefined,
      lifecycle: 'setNull',
    })
    expect(keyIntent(fk(['missing'], 'b'), items).required).toBeUndefined()
  })
})

describe('keyReading', () => {
  it('says only what is known, in order: how many, a must, what a delete does', () => {
    expect(keyReading('order_items', 'orders', { oneToOne: false, required: true, lifecycle: 'cascade' })).toEqual([
      w.oneToMany('order_items', 'orders'),
      w.required('order_items', 'orders'),
      w.lifecycle.cascade('order_items', 'orders'),
    ])
    expect(keyReading('a', 'b', { oneToOne: undefined, required: undefined, lifecycle: 'restrict' })).toEqual([
      w.lifecycle.restrict('a', 'b'),
    ])
  })
})

describe('tableReading', () => {
  it('reads history, soft delete, a stage, and unique columns that are not keys to another table', () => {
    const users = table('users', {
      columns: ['id', 'email', 'created_at', 'updatedAt', 'deleted_at', 'order_status', 'org_id'].map((n) =>
        column(n, 'text')
      ),
      indexes: [index(['email'], { unique: true }), index(['org_id'], { unique: true })],
      foreignKeys: [fk(['org_id'], 'orgs')],
    })
    expect(tableReading(users)).toEqual([
      w.history('created_at, updatedAt'),
      w.softDelete('deleted_at'),
      w.state('order_status'),
      w.naturalKey(['email']),
    ])
    expect(tableReading(table('t', { columns: [column('creator', 'text'), column('statuses', 'text')] }))).toEqual([])
  })
})

describe('designSummary', () => {
  it('sorts the keys by what a delete does, a line for each kind there is, each pair once', () => {
    const k = (child: string, parent: string, lifecycle: 'cascade' | 'restrict' | 'setNull') => ({
      child,
      parent,
      intent: { oneToOne: undefined, required: undefined, lifecycle },
    })
    expect(
      designSummary([
        k('items', 'orders', 'cascade'),
        k('items', 'orders', 'cascade'),
        k('orders', 'users', 'restrict'),
      ])
    ).toEqual([w.parts([w.pair('items', 'orders')]), w.guarded([w.pair('orders', 'users')])])
    expect(designSummary([k('orders', 'addresses', 'setNull')])).toEqual([w.loose([w.pair('orders', 'addresses')])])
  })
})

describe('comments', () => {
  it('names a table with the first line of its comment, cut short, and nothing for none', () => {
    expect(named('users', '会員\n詳しくは…')).toBe(w.named('users', '会員'))
    expect(named('users', '  ')).toBe('users')
    expect(named('users', null)).toBe('users')
    expect(shortComment('x'.repeat(40))).toBe(`${'x'.repeat(29)}…`)
  })

  it("says what a key column's comment says, for the columns that have one", () => {
    const orders = table('orders', {
      columns: [column('user_id', 'int', { comment: '注文した会員' }), column('note', 'text')],
    })
    expect(columnComments('orders', ['user_id', 'note'], orders)).toEqual([
      w.columnComment('orders', 'user_id', '注文した会員'),
    ])
    expect(columnComments('orders', ['user_id'])).toEqual([])
  })
})

describe('keyTuning', () => {
  const orders = table('orders', { columns: [column('id', 'bigint')] })

  it('hints at a key no index starts with, and not at one an index or the primary key serves', () => {
    const key = fk(['order_id'], 'orders')
    expect(keyTuning(key, 'order_items', 'orders', items, orders)).toEqual([
      w.unindexed('order_items', 'order_id', 'orders'),
    ])
    const served = { ...items, indexes: [index(['order_id', 'id'])] }
    expect(keyTuning(key, 'order_items', 'orders', served, orders)).toEqual([])
    expect(keyTuning(key, 'order_items', 'orders', { ...items, primaryKey: ['order_id', 'id'] }, orders)).toEqual([])
    expect(keyTuning(key, 'order_items', 'orders')).toEqual([])
  })

  it('hints at a key column of another kind than the one it refers to, not at one of the same kind', () => {
    const key = fk(['order_id'], 'orders')
    const texty = { ...items, columns: [column('order_id', 'varchar(20)')], indexes: [index(['order_id'])] }
    expect(keyTuning(key, 'order_items', 'orders', texty, orders)).toEqual([
      w.typeMismatch('order_items.order_id', 'varchar(20)', 'orders.id', 'bigint'),
    ])
    const wider = { ...texty, columns: [column('order_id', 'int')] }
    expect(keyTuning(key, 'order_items', 'orders', wider, orders)).toEqual([])
  })
})

describe('tableTuning', () => {
  it('hints at no primary key, an index another starts with, and many indexes; nothing for a view', () => {
    const t = table('logs', {
      primaryKey: [],
      indexes: [index(['status']), index(['status', 'at']), index(['email'], { unique: true })],
    })
    expect(tableTuning('logs', t)).toEqual([
      w.noPrimaryKey('logs'),
      w.redundantIndex('ix_status', 'status', 'ix_status_at'),
    ])
    const many = table('wide', { indexes: Array.from({ length: 9 }, (_, i) => index([`c${i}`])) })
    expect(tableTuning('wide', many)).toEqual([w.manyIndexes('wide', 9)])
    expect(tableTuning('v', table('v', { kind: 'view', primaryKey: [] }))).toEqual([])
  })

  it('does not take a partial index, or one of another type, as serving the same searches', () => {
    const t = table('t', {
      indexes: [index(['a']), index(['a', 'b'], { predicate: 'b > 0' }), index(['a', 'c'], { type: 'gin' })],
    })
    expect(tableTuning('t', t)).toEqual([])
  })
})
