import type { Cell } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { chaptersOf } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, table } from '@/test/schema-fixtures.ts'
import { type RowGraph, type RowNode, rowNode } from './row-graph.ts'
import { REFERRING_DRAWN, ROWS_DRAWN, restoreReferring, rowTour, trimReferring, valueText } from './row-tour.ts'

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
      t.referredTitle('order_items', lines.length, true),
      t.fartherTitle('order_items', 'products'),
      t.endTitle,
    ])
    expect(tour?.scenes[0]?.text).toContain(w.named('orders', '注文'))
    expect(chaptersOf(tour?.scenes ?? [])).toEqual([
      { title: t.chapters.row, from: 0, to: 2 },
      { title: t.chapters.referred, from: 2, to: 3 },
      { title: t.chapters.farther, from: 3, to: 5 },
    ])
    expect(tour?.scenes[2]?.text).toBe(t.referred('order_items', REFERRING_DRAWN, 1, true, 'order_id', 'id = 1'))
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

  it('counts the rows referring past the rows drawn, and tells a table none of whose rows could be drawn', () => {
    // Five tables of three rows each refer to the order: more than the picture holds.
    const tables = ['a', 'b', 'c', 'd', 'e']
    const kids = tables.flatMap((x) =>
      [1, 2, 3].map((id) => row(x, page(['id', 'order_id'], { foreignKeys: [fk(['order_id'], 'orders')] }), [id, 1]))
    )
    const g: RowGraph = {
      nodes: new Map([order, ...kids].map((n) => [n.id, n])),
      arrows: kids.map((k) => ({ from: k.id, to: order.id, label: 'order_id' })),
      more: [],
      expanded: new Set(),
    }
    const scenes = rowTour(g, order.id)?.scenes ?? []
    const told = tables.map((x) => scenes.find((s) => s.title === t.referredTitle(x, 3, true)))
    expect(told.every(Boolean)).toBe(true)
    const drawn = ROWS_DRAWN - 1
    expect(told[3]?.text).toBe(t.referred('d', drawn - 9, 3 - (drawn - 9), true, 'order_id', 'id = 1'))
    expect(told[4]?.text).toBe(t.referredUndrawn('e', 3, true, 'order_id', 'id = 1'))
  })

  it('keeps the first row when it refers to itself, and puts back a row cut that comes back another way', () => {
    const staff = page(['id', 'boss_id'], { foreignKeys: [fk(['boss_id'], 'staff')] })
    const boss = row('staff', staff, [1, 1])
    const reports = [2, 3, 4, 5].map((id) => row('staff', staff, [id, 1]))
    const g: RowGraph = {
      nodes: new Map([boss, ...reports].map((n) => [n.id, n])),
      arrows: [
        { from: boss.id, to: boss.id, label: 'boss_id' },
        ...reports.map((r) => ({ from: r.id, to: boss.id, label: 'boss_id' })),
      ],
      more: [],
      expanded: new Set(),
    }
    const trimmed = trimReferring(g, boss.id)
    expect(trimmed.graph.nodes.has(boss.id)).toBe(true)
    expect(trimmed.graph.nodes.size).toBe(1 + REFERRING_DRAWN)
    expect([...trimmed.left.values()]).toEqual([1])
    // The row cut is met again further on: its key to the first row is back, and it is no longer counted out.
    const last = reports[3] as RowNode
    const again: RowGraph = { ...trimmed.graph, nodes: new Map([...trimmed.graph.nodes, [last.id, last]]) }
    const back = restoreReferring(again, trimmed.cut, trimmed.left)
    expect(back.graph.arrows.some((a) => a.from === last.id && a.to === boss.id)).toBe(true)
    expect([...back.left.values()]).toEqual([0])
  })

  it('lists every value a line starts or ends at, however many, and draws no key whose columns are not known', () => {
    const names = ['id', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']
    const wide = row(
      'wide',
      page(names, { foreignKeys: names.slice(1).map((c) => fk([c], 'orders', { name: `fk_${c}` })) }),
      [9, 1, 1, 1, 1, 1, 1]
    )
    const g: RowGraph = {
      nodes: new Map([
        [order.id, order],
        [wide.id, wide],
      ]),
      arrows: [
        ...names.slice(1).map((c) => ({ from: wide.id, to: order.id, label: c })),
        { from: order.id, to: wide.id, label: 'nothing_known' },
      ],
      more: [],
      expanded: new Set(),
    }
    const tour = rowTour(g, order.id)
    const box = tour?.diagram.columns.get('wide id=9') ?? []
    for (const r of tour?.diagram.relations ?? []) {
      expect(tour?.diagram.columns.get(r.table)).toContain(r.columns[0])
      expect(tour?.diagram.columns.get(r.refTable)).toContain(r.refColumns[0])
    }
    expect(box).toHaveLength(names.length)
    expect(tour?.diagram.relations).toHaveLength(names.length - 1)
  })

  it('counts the rows never read (more than a page reads), and says "or more" where they were not counted exactly', () => {
    const g = graph()
    const moreId = JSON.stringify(['more', order.id, '', 'order_items', 'order_id'])
    const withMore = (count: number | null): RowGraph => ({
      ...g,
      more: [{ id: moreId, to: order.id, ref: shop('order_items'), filters: [], count }],
      arrows: [...g.arrows, { from: moreId, to: order.id, label: 'order_id' }],
    })
    const cut = (x: RowGraph) => trimReferring(x, order.id)
    const told = (x: RowGraph) => rowTour(cut(x).graph, order.id, cut(x).left)?.scenes[2]
    expect(told(withMore(490))?.title).toBe(t.referredTitle('order_items', lines.length + 490, true))
    const inexact = told(withMore(null))
    expect(inexact?.title).toBe(t.referredTitle('order_items', lines.length, false))
    expect(inexact?.text).toBe(t.referred('order_items', REFERRING_DRAWN, 1, false, 'order_id', 'id = 1'))
  })
})
