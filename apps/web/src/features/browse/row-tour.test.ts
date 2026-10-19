import type { Cell } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, table } from '@/test/schema-fixtures.ts'
import { type RowGraph, type RowNode, rowNode } from './row-graph.ts'
import { REFERRING_DRAWN, rowTour, trimReferring, valueText } from './row-tour.ts'

const t = locale.rowTour
const w = locale.designReading

const shop = (table: string) => ({ db: 'shop', schema: undefined, table })
type Page = RowNode['page']
const page = (names: string[], over: Partial<Page> = {}): Page => ({
  columns: names.map((name) => ({ name, dataType: 'int' })),
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [],
  referencedBy: [],
  ...over,
})
const orders = page(['id', 'user_id'], { foreignKeys: [fk(['user_id'], 'users', { onDelete: 'RESTRICT' })] })
const users = page(['id', 'email'])
const items = page(['id', 'order_id', 'product_id'], {
  foreignKeys: [fk(['order_id'], 'orders', { onDelete: 'CASCADE' }), fk(['product_id'], 'products')],
})
const products = page(['id', 'name'])

const row = (t: string, p: Page, values: Cell[]) => rowNode(shop(t), p, values)
const order = row('orders', orders, [1, 7])
const alice = row('users', users, [7, 'alice@example.com'])
const lines = [11, 12, 13, 14].map((id) => row('order_items', items, [id, 1, 5]))
const cookie = row('products', products, [5, 'Cookie'])

/** The graph as the tour reads it: the order, its user, its four lines, and the product of the first. */
function graph(): RowGraph {
  const nodes = new Map([order, alice, ...lines, cookie].map((n) => [n.id, n]))
  return {
    nodes,
    arrows: [
      { from: order.id, to: alice.id, label: 'user_id' },
      ...lines.map((l) => ({ from: l.id, to: order.id, label: 'order_id' })),
      { from: lines[0]?.id ?? '', to: cookie.id, label: 'product_id' },
    ],
    more: [],
    expanded: new Set([order.id]),
  }
}

const definitions = new Map([
  [
    'orders',
    table('orders', {
      comment: '注文',
      columns: [column('id', 'int'), column('user_id', 'int', { nullable: false, comment: '注文した会員' })],
    }),
  ],
  ['users', table('users', { comment: '会員', columns: [column('id', 'int'), column('email', 'text')] })],
  [
    'order_items',
    table('order_items', { columns: [column('order_id', 'int', { nullable: false }), column('product_id', 'int')] }),
  ],
])
const schemaOf = (ref: { table: string }) => definitions.get(ref.table)

describe('valueText', () => {
  it('shows NULL, a mark for what cannot be shown, and a long value cut short', () => {
    expect(valueText(null)).toBe('NULL')
    expect(valueText({ binary: 'ab', bytes: 2 } as unknown as Cell)).toBe('…')
    expect(valueText('x'.repeat(30))).toBe(`${'x'.repeat(23)}…`)
    expect(valueText(42)).toBe('42')
  })
})

describe('trimReferring', () => {
  it('keeps a few rows referring to the first row per table and key, and counts the rest', () => {
    const { graph: kept, left } = trimReferring(graph(), order.id)
    expect([...kept.nodes.values()].filter((n) => n.ref.table === 'order_items')).toHaveLength(REFERRING_DRAWN)
    expect([...left.values()]).toEqual([lines.length - REFERRING_DRAWN])
    expect(kept.arrows.some((a) => a.from === lines[3]?.id)).toBe(false)
  })
})

describe('rowTour', () => {
  const { graph: kept, left } = trimReferring(graph(), order.id)
  const tour = rowTour(kept, order.id, left, schemaOf)

  it('tells the row, what it refers to, what refers to it, one step further, and what it all comes to', () => {
    expect(tour?.scenes.map((s) => s.title)).toEqual([
      'orders id=1',
      t.refersTitle('users'),
      t.referredTitle('order_items', lines.length),
      t.fartherTitle('order_items', 'products'),
      t.endTitle,
    ])
    expect(tour?.scenes[0]?.text).toContain(w.named('orders', '注文'))
    expect(tour?.scenes[2]?.text).toBe(t.referred('order_items', REFERRING_DRAWN, 1, 'order_id', 'id = 1'))
  })

  it('draws rows as boxes of values, a key as a line from the value that refers to the one referred to', () => {
    const toUser = tour?.diagram.relations.find((r) => r.table === 'orders id=1' && r.refTable === 'users id=7')
    expect(toUser?.columns).toEqual(['user_id = 7'])
    expect(toUser?.refColumns).toEqual(['id = 7'])
    expect(tour?.diagram.columns.get('users id=7')).toEqual(['id = 7', 'email = alice@example.com'])
  })

  it('says why: the comment of the key column, how many, a must, what a delete does; and where it costs time', () => {
    const refers = tour?.scenes[1]
    expect(refers?.notes).toEqual([
      w.columnComment('orders', 'user_id', '注文した会員'),
      w.oneToMany(w.named('orders', '注文'), w.named('users', '会員')),
      w.required(w.named('orders', '注文'), w.named('users', '会員')),
      w.lifecycle.restrict(w.named('orders', '注文'), w.named('users', '会員')),
    ])
    expect(refers?.hints).toEqual([w.unindexed('orders', 'user_id', 'users')])
    expect(tour?.scenes[2]?.notes).toContain(w.lifecycle.cascade('order_items', w.named('orders', '注文')))
    expect(tour?.scenes.at(-1)?.notes).toEqual([
      w.parts([w.pair('order_items', 'orders')]),
      w.guarded([w.pair('orders', 'users'), w.pair('order_items', 'products')]),
    ])
  })

  it('keeps what was seen lit, fainter, and flows only the keys of the scene', () => {
    const further = tour?.scenes[3]
    expect(further?.overlay.tables.get('orders id=1')?.tone).toBe('index')
    expect(further?.overlay.tables.get('products id=5')?.tone).toBe('focus')
    const flowing = [...(further?.overlay.flow?.keys() ?? [])]
    const toProduct = tour?.diagram.relations.find((r) => r.refTable === 'products id=5')
    expect(flowing).toEqual([relationKey(toProduct ?? { table: '', name: '' })])
  })

  it('tells two rows apart that would be named the same, rather than drawing them as one box', () => {
    // Two keys that print alike (a number and a string): two rows, two ids, one name.
    const a = row('users', users, [1, 'a@example.com'])
    const b = row('users', users, ['1', 'b@example.com'])
    const g: RowGraph = {
      nodes: new Map([
        [order.id, order],
        [a.id, a],
        [b.id, b],
      ]),
      arrows: [],
      more: [],
      expanded: new Set(),
    }
    expect(a.id).not.toBe(b.id)
    expect(rowTour(g, order.id)?.diagram.tables).toEqual(['orders id=1', 'users id=1', 'users id=1 (2)'])
  })

  it('tells nothing for a row that is not in the graph', () => {
    expect(rowTour(graph(), 'missing')).toBeUndefined()
  })
})
