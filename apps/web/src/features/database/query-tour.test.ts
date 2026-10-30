import type { QueryBuilderRequestInput, QueryJoinStep, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { chaptersOf } from '@/components/schema-diagram/tour.ts'
import { locale } from '@/config/locale-screens.ts'
import { column, fk, index, relation, table } from '@/test/schema-fixtures.ts'
import { queryTour } from './query-tour.ts'

const t = locale.queryTour
const w = locale.designReading

// orders(user_id NOT NULL → users), items(order_id → orders, no index), users with a comment.
const schemas = new Map<string, TableSchema>([
  [
    'orders',
    table('orders', {
      comment: '注文',
      columns: [column('id', 'int'), column('user_id', 'int', { nullable: false }), column('status', 'text')],
      indexes: [index(['user_id'])],
      foreignKeys: [fk(['user_id'], 'users', { name: 'fk_user' })],
    }),
  ],
  ['users', table('users', { columns: [column('id', 'int'), column('email', 'text')] })],
  [
    'items',
    table('items', {
      columns: [column('id', 'int'), column('order_id', 'int')],
      foreignKeys: [fk(['order_id'], 'orders', { name: 'fk_order' })],
    }),
  ],
])
const keys = [
  relation('orders', ['user_id'], 'users', { name: 'fk_user' }),
  relation('items', ['order_id'], 'orders', { name: 'fk_order' }),
]
// As the server joins them: users along the key of orders, items along its own key to orders.
const joins: QueryJoinStep[] = [
  {
    table: 'users',
    kind: 'left',
    on: [{ a: { table: 'users', column: 'id' }, b: { table: 'orders', column: 'user_id' } }],
    key: { table: 'orders', name: 'fk_user' },
  },
  {
    table: 'items',
    kind: 'left',
    on: [{ a: { table: 'orders', column: 'id' }, b: { table: 'items', column: 'order_id' } }],
    key: { table: 'items', name: 'fk_order' },
  },
]
const request: QueryBuilderRequestInput = {
  tables: ['orders', 'users', 'items'],
  columns: [
    { table: 'orders', column: 'id', alias: '', show: true, sort: 'desc' as const },
    { table: 'users', column: 'email', alias: 'mail', show: true, sort: null },
  ],
  where: [[{ table: 'items', column: 'id', op: 'gt' as const, value: '3' }]],
}

describe('queryTour', () => {
  const { diagram, scenes } = queryTour({ request, joins, schemas, keys })
  const titled = (title: string) => scenes.find((s) => s.title === title)

  it('tells the query in the order the database works it, not the order it is written', () => {
    expect(scenes.map((s) => s.title)).toEqual([
      t.introTitle,
      t.fromTitle('orders'),
      t.joinTitle('left', 'users'),
      t.joinTitle('left', 'items'),
      t.whereTitle,
      t.selectTitle,
      t.orderTitle,
      t.endTitle,
    ])
    expect(scenes[0]?.text).toBe(t.intro(3, w.named('orders', '注文')))
    // Chapters for a video each: the tables and their joins, the conditions, and what comes out.
    expect(chaptersOf(scenes)).toEqual([
      { title: t.chapters.tables, from: 0, to: 4 },
      { title: t.chapters.where, from: 4, to: 5 },
      { title: t.chapters.output, from: 5, to: 8 },
    ])
  })

  it('flows the key each table is joined along, keeping the tables joined before lit', () => {
    const items = titled(t.joinTitle('left', 'items'))
    const toOrders = keys[1] ?? keys[0]
    expect([...(items?.overlay.flow?.keys() ?? [])]).toEqual([relationKey(toOrders ?? { table: '', name: '' })])
    expect(items?.overlay.tables.get('orders')?.tone).toBe('index')
    expect(items?.overlay.tables.get('users')?.tone).toBe('index')
    expect(items?.overlay.tables.get('items')?.tone).toBe('focus')
    expect(items?.overlay.columns.get('items')).toEqual(new Set(['order_id']))
  })

  it('says where the rows multiply, where they cannot, and a LEFT JOIN that always finds a row', () => {
    const users = titled(t.joinTitle('left', 'users'))
    expect(users?.notes).toEqual([
      t.alongKey('fk_user'),
      t.atMostOne(w.named('orders', '注文'), 'users'),
      t.leftAlwaysFound('orders', 'users'),
    ])
    const items = titled(t.joinTitle('left', 'items'))
    expect(items?.notes).toEqual([t.alongKey('fk_order'), t.multiplies(w.named('orders', '注文'), 'items')])
    // The rows that refer are looked up by the key: no index on it is where a join reads every row.
    expect(items?.hints).toEqual([w.unindexed('items', 'order_id', 'orders')])
    expect(users?.hints).toEqual([])
    expect(scenes.at(-1)?.notes).toEqual([t.multiplies(w.named('orders', '注文'), 'items')])
  })

  it("adds the catalog's estimated rows: of the table it starts from, and of one table per row of the other", () => {
    const rows = new Map([
      ['orders', 500],
      ['users', 100],
      ['items', 2000],
    ])
    const s = queryTour({ request, joins, schemas, keys, rows }).scenes
    const named = w.named('orders', '注文')
    expect(s[1]?.notes?.[0]).toBe(w.rows(named, 500))
    // Then the rows so far: users at most one per order (500), items four per order (2,000).
    expect(s.find((x) => x.title === t.joinTitle('left', 'users'))?.notes?.slice(-2)).toEqual([
      w.perRow('users', named, 5),
      t.runningRows(500, false, false),
    ])
    expect(s.find((x) => x.title === t.joinTitle('left', 'items'))?.notes?.slice(-2)).toEqual([
      w.perRow(named, 'items', 4),
      t.runningRows(2000, false, false),
    ])
    expect(s.at(-1)?.notes?.at(-1)).toBe(t.runningRows(2000, false, false))
    // items is looked up by a key no index starts with: how many rows that reads.
    expect(s.find((x) => x.title === t.joinTitle('left', 'items'))?.hints).toEqual([
      w.unindexed('items', 'order_id', 'orders'),
      w.unindexedRows('items', 2000),
    ])
    // Joined the other way, orders is looked up by its primary key: nothing of the rows of items.
    const reversed = queryTour({
      request: { tables: ['items', 'orders'] },
      joins: [
        {
          table: 'orders',
          kind: 'inner',
          on: [{ a: { table: 'orders', column: 'id' }, b: { table: 'items', column: 'order_id' } }],
          key: { table: 'items', name: 'fk_order' },
        },
      ],
      schemas,
      keys,
      rows,
    }).scenes.find((x) => x.title === t.joinTitle('inner', 'orders'))
    expect(reversed?.hints).toEqual([])
  })

  it('reads the conditions in words, and what a condition on a LEFT JOINed table undoes', () => {
    const where = titled(t.whereTitle)
    expect(where?.text).toBe(t.where(t.condition('items.id', locale.search.ops.gt, "'3'")))
    expect(where?.notes).toEqual([t.leftToInner('items')])
    expect(where?.overlay.columns.get('items')).toEqual(new Set(['id']))
    // items has the primary key on id: no hint.
    expect(where?.hints).toEqual([])
  })

  it('names the order and the columns taken, with their names; and the columns used are in their boxes', () => {
    expect(titled(t.orderTitle)?.text).toBe(t.order(t.list([t.desc('orders.id')])))
    expect(titled(t.selectTitle)?.text).toBe(t.select(t.list(['orders.id', t.alias('users.email', 'mail')])))
    expect(diagram.columns.get('users')).toContain('email')
  })

  it('tells one table with no condition: from it, sorted (without an index), every column', () => {
    const one = queryTour({
      request: { tables: ['orders'], columns: [{ table: 'orders', column: 'status', show: false, sort: 'asc' }] },
      joins: [],
      schemas,
      keys,
    }).scenes
    expect(one.map((s) => s.title)).toEqual([
      t.introTitle,
      t.fromTitle('orders'),
      t.selectTitle,
      t.orderTitle,
      t.endTitle,
    ])
    expect(one[3]?.hints).toEqual([t.orderUnindexed('orders', 'status')])
    expect(one[2]?.text).toBe(t.selectAll)
    expect(one.at(-1)?.text).toBe(t.end('orders', 0, false, true, 0))
  })

  it('draws a join spelled out as a line of its own, not a foreign key, and hints at its columns without an index', () => {
    const spelled: QueryJoinStep[] = [
      {
        table: 'items',
        kind: 'inner',
        on: [{ a: { table: 'items', column: 'id' }, b: { table: 'orders', column: 'status' } }],
        key: null,
      },
    ]
    const { diagram: d, scenes: s } = queryTour({
      request: { tables: ['orders', 'items'] },
      joins: spelled,
      schemas,
      keys,
    })
    const line = d.relations.find((r) => r.name.startsWith('\u0000'))
    expect(line).toMatchObject({ table: 'items', columns: ['id'], refTable: 'orders', refColumns: ['status'] })
    const join = s.find((x) => x.title === t.joinTitle('inner', 'items'))
    expect(join?.notes).toEqual([t.spelled])
    expect(join?.hints).toEqual([])
    // On a column no index starts with: a hint.
    const unindexed = queryTour({
      request: { tables: ['orders', 'items'] },
      joins: [
        {
          ...spelled[0],
          on: [{ a: { table: 'items', column: 'order_id' }, b: { table: 'orders', column: 'id' } }],
        } as QueryJoinStep,
      ],
      schemas,
      keys,
    }).scenes.find((x) => x.title === t.joinTitle('inner', 'items'))
    expect(unindexed?.hints).toEqual([t.joinUnindexed('items', 'order_id')])
  })

  it('says nothing of a LEFT JOIN undone where the conditions are OR-ed, or ask for NULL', () => {
    const where = (w2: QueryBuilderRequestInput['where']) =>
      queryTour({ request: { ...request, where: w2 }, joins, schemas, keys }).scenes.find(
        (s) => s.title === t.whereTitle
      )
    const isNull = { table: 'items', column: 'id', op: 'is_null' as const }
    expect(where([[isNull]])?.notes).toEqual([])
    const other = { table: 'orders', column: 'status', op: 'eq' as const, value: 'x' }
    const or = where([[{ table: 'items', column: 'id', op: 'gt', value: '3' }], [other]])
    expect(or?.notes).toEqual([])
    expect(or?.text).toBe(
      t.where(
        [
          t.condition('items.id', locale.search.ops.gt, "'3'"),
          t.condition('orders.status', locale.search.ops.eq, "'x'"),
        ].join(t.or)
      )
    )
    expect(or?.hints).toEqual([t.whereUnindexed('orders.status')])
  })

  it('does not say a LEFT JOIN always finds its row where the row that refers may itself be NULL', () => {
    // items LEFT JOINed to orders first: an order without items has items NULL, and then no user either.
    const itemsUser = new Map(schemas)
    itemsUser.set(
      'items',
      table('items', {
        columns: [column('id', 'int'), column('order_id', 'int'), column('user_id', 'int', { nullable: false })],
        foreignKeys: [fk(['order_id'], 'orders', { name: 'fk_order' }), fk(['user_id'], 'users', { name: 'fk_iu' })],
      })
    )
    const steps: QueryJoinStep[] = [
      joins[1] as QueryJoinStep,
      {
        table: 'users',
        kind: 'left',
        on: [{ a: { table: 'users', column: 'id' }, b: { table: 'items', column: 'user_id' } }],
        key: { table: 'items', name: 'fk_iu' },
      },
    ]
    const s = queryTour({
      request: { tables: ['orders', 'items', 'users'] },
      joins: steps,
      schemas: itemsUser,
      keys: [...keys, relation('items', ['user_id'], 'users', { name: 'fk_iu' })],
    }).scenes.find((x) => x.title === t.joinTitle('left', 'users'))
    expect(s?.notes).toEqual([t.alongKey('fk_iu'), t.atMostOne('items', 'users')])
  })

  it('in a RIGHT JOIN, looks for the index on the rows looked up, and takes the tables before it as maybe NULL', () => {
    const right: QueryJoinStep = {
      table: 'items',
      kind: 'right',
      on: [{ a: { table: 'items', column: 'order_id' }, b: { table: 'orders', column: 'status' } }],
      key: null,
    }
    const tour = queryTour({
      request: { tables: ['orders', 'items'], where: [[{ table: 'orders', column: 'status', op: 'eq', value: 'x' }]] },
      joins: [right],
      schemas,
      keys,
    }).scenes
    // The rows of items are all kept; those of orders are looked up, by status, which no index starts with.
    expect(tour.find((x) => x.title === t.joinTitle('right', 'items'))?.hints).toEqual([
      t.joinUnindexed('orders', 'status'),
    ])
    expect(tour.find((x) => x.title === t.whereTitle)?.notes).toEqual([t.leftToInner('orders')])
  })

  describe('the rows so far, reckoned from the estimates', () => {
    const rows = new Map([
      ['orders', 500],
      ['users', 100],
      ['items', 2000],
    ])
    type Rows = ReadonlyMap<string, number | { counted: number }>
    const [toUsers, toItems] = joins as [QueryJoinStep, QueryJoinStep]
    /** The last thing each join's scene says, then the summary's: where the rows so far are told. */
    const told = (steps: QueryJoinStep[], r: Rows = rows, first = 'orders', s = schemas) => {
      const scenes = queryTour({
        request: { tables: [first, ...steps.map((x) => x.table)] },
        joins: steps,
        schemas: s,
        keys,
        rows: r,
      }).scenes
      return [
        ...steps.map((x) => scenes.find((c) => c.title === t.joinTitle(x.kind, x.table))?.notes?.at(-1)),
        scenes.at(-1)?.notes?.at(-1),
      ]
    }
    const est = (n: number, atMost = false) => t.runningRows(n, atMost, false)
    // The sentence ends the same whatever its numbers.
    const isRunning = (n: string | undefined) => n?.endsWith(t.runningRows(0, false, false).slice(-20)) === true
    // items with a key that may be NULL, and orders joined along it from items.
    const looseItems = new Map(schemas)
    looseItems.set(
      'items',
      table('items', {
        columns: [column('id', 'int'), column('order_id', 'int')],
        foreignKeys: [fk(['order_id'], 'orders', { name: 'fk_order' })],
      })
    )
    const ordersFromItems = (kind: QueryJoinStep['kind']): QueryJoinStep => ({
      table: 'orders',
      kind,
      on: [{ a: { table: 'orders', column: 'id' }, b: { table: 'items', column: 'order_id' } }],
      key: { table: 'items', name: 'fk_order' },
    })

    it('multiplies by the rows that refer per row in an INNER JOIN, and keeps a row with none in a LEFT JOIN', () => {
      // A tenth of an item per order: an INNER JOIN keeps a tenth of the rows, a LEFT JOIN every order.
      const few = new Map([...rows, ['items', 50]])
      expect(told([{ ...toItems, kind: 'inner' }], few)).toEqual([est(50), est(50)])
      expect(told([toItems], few)).toEqual([est(500), est(500)])
      // Four per order, through users (one per order) first.
      expect(told([toUsers, toItems])).toEqual([est(500), est(2000), est(2000)])
    })

    it('takes one to one as a row at most', () => {
      const one = new Map(schemas)
      one.set(
        'items',
        table('items', {
          columns: [column('id', 'int'), column('order_id', 'int')],
          indexes: [index(['order_id'], { unique: true })],
          foreignKeys: [fk(['order_id'], 'orders', { name: 'fk_order' })],
        })
      )
      // One item per order at most (a unique key on order_id): never more rows, though the estimates count more items.
      expect(told([{ ...toItems, kind: 'inner' }], rows, 'orders', one)).toEqual([est(500), est(500)])
    })

    it('says at most where an INNER JOIN may drop rows, and keeps saying it after', () => {
      // orders.user_id is NOT NULL: every order finds its user.
      expect(told([{ ...toUsers, kind: 'inner' }])).toEqual([est(500), est(500)])
      // items.order_id may be NULL: an INNER JOIN to orders may drop items; a LEFT JOIN does not.
      expect(told([ordersFromItems('inner')], rows, 'items', looseItems)).toEqual([est(2000, true), est(2000, true)])
      expect(told([ordersFromItems('left')], rows, 'items', looseItems)).toEqual([est(2000), est(2000)])
      // Carried on: then users, one per order.
      const users: QueryJoinStep = { ...toUsers, kind: 'left' }
      expect(told([ordersFromItems('inner'), users], rows, 'items', looseItems)).toEqual([
        est(2000, true),
        est(2000, true),
        est(2000, true),
      ])
    })

    it('says at most where a table an outer join may leave NULL is joined on', () => {
      // users, then its orders LEFT JOINed (an order may be NULL), then their items INNER JOINed: the NULL orders
      // meet no items and are dropped.
      const ordersOfUsers: QueryJoinStep = {
        table: 'orders',
        kind: 'left',
        on: [{ a: { table: 'orders', column: 'user_id' }, b: { table: 'users', column: 'id' } }],
        key: { table: 'orders', name: 'fk_user' },
      }
      expect(told([ordersOfUsers, { ...toItems, kind: 'inner' }], rows, 'users')).toEqual([
        est(500),
        est(2000, true),
        est(2000, true),
      ])
      // The table referred to, INNER JOINed along a NOT NULL key of a table that may be NULL: shops of the orders.
      const shops = new Map(schemas)
      shops.set(
        'orders',
        table('orders', {
          columns: [column('id', 'int'), column('user_id', 'int'), column('shop_id', 'int', { nullable: false })],
          foreignKeys: [fk(['user_id'], 'users', { name: 'fk_user' }), fk(['shop_id'], 'shops', { name: 'fk_shop' })],
        })
      )
      shops.set('shops', table('shops', { columns: [column('id', 'int')] }))
      const toShops = relation('orders', ['shop_id'], 'shops', { name: 'fk_shop' })
      const scenes = queryTour({
        request: { tables: ['users', 'orders', 'shops'] },
        joins: [
          ordersOfUsers,
          {
            table: 'shops',
            kind: 'inner',
            on: [{ a: { table: 'shops', column: 'id' }, b: { table: 'orders', column: 'shop_id' } }],
            key: { table: 'orders', name: 'fk_shop' },
          },
        ],
        schemas: shops,
        keys: [...keys, toShops],
        rows: new Map([...rows, ['shops', 10]]),
      }).scenes
      expect(scenes.at(-1)?.notes?.at(-1)).toBe(est(500, true))
    })

    it('rounds past a hundred, and says nothing past a RIGHT JOIN, a join of its own columns, or a table with no number', () => {
      const big = new Map([...rows, ['orders', 123456], ['items', 1234567]])
      // 10 items per order: 1,234,567 rounded to two digits.
      expect(told([toItems], big)[0]).toBe(est(1200000))
      // 99.6 → 100, 950 stays, 999.6 → 1,000.
      expect(
        told(
          [toItems],
          new Map([
            ['orders', 1000],
            ['items', 99.6],
          ])
        )[0]
      ).toBe(est(1000))
      expect(
        told(
          [{ ...toItems, kind: 'inner' }],
          new Map([
            ['orders', 1000],
            ['items', 99.6],
          ])
        )[0]
      ).toBe(est(100))
      expect(
        told(
          [{ ...toItems, kind: 'inner' }],
          new Map([
            ['orders', 1000],
            ['items', 950],
          ])
        )[0]
      ).toBe(est(950))
      expect(
        told(
          [{ ...toItems, kind: 'inner' }],
          new Map([
            ['orders', 1000],
            ['items', 999.6],
          ])
        )[0]
      ).toBe(est(1000))
      expect(told([{ ...toItems, kind: 'right' }]).some(isRunning)).toBe(false)
      expect(told([{ ...toItems, key: null }]).some(isRunning)).toBe(false)
      expect(told([toItems], new Map([['orders', 500]])).some(isRunning)).toBe(false)
    })

    it('says counted where every number was counted, and nothing where the table referred to has no rows', () => {
      const counted = new Map<string, number | { counted: number }>([
        ['orders', { counted: 10 }],
        ['items', { counted: 30 }],
      ])
      expect(told([toItems], counted)).toEqual([t.runningRows(30, false, true), t.runningRows(30, false, true)])
      // One estimated: reckoned from estimates.
      expect(told([toItems], new Map([...counted, ['items', 30]]))[0]).toBe(est(30))
      expect(told([toItems], new Map([...counted, ['orders', 10]]))[0]).toBe(est(30))
      // No orders counted: no average to reckon with, and nothing told of the rows so far.
      const empty = told([toItems], new Map([...counted, ['orders', { counted: 0 }]]))
      expect(empty.some(isRunning)).toBe(false)
    })
  })
})
