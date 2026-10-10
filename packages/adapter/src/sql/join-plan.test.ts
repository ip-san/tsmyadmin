import type { Namespace, QueryBuilderJoin, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { refuses } from '../test/ddl-helpers.ts'
import { joinPlan } from './join-plan.ts'

type Link = { columns: string[]; refTable: string; refColumns: string[]; ref?: { database: string; schema?: string } }
const table = (columns: string[], links: Link[] = []) =>
  ({
    columns: columns.map((name) => ({ name })),
    foreignKeys: links.map((l, i) => ({
      name: `fk${i}`,
      columns: l.columns,
      refNamespace: l.ref ?? { database: 'd' },
      refTable: l.refTable,
      refColumns: l.refColumns,
      onUpdate: null,
      onDelete: null,
    })),
  }) as unknown as TableSchema

/** customers <- orders <- items, each pointing at the one before. */
const shop = new Map<string, TableSchema>([
  ['customers', table(['id', 'name'])],
  ['orders', table(['id', 'customer_id'], [{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }])],
  ['items', table(['id', 'order_id'], [{ columns: ['order_id'], refTable: 'orders', refColumns: ['id'] }])],
])
const my = { database: 'd' }
const plan = (tables: string[], schemas = shop, explicit: QueryBuilderJoin[] = [], ns = my) =>
  joinPlan('mysql', ns, tables, schemas, explicit)
describe('joinPlan along foreign keys', () => {
  it('joins nothing for a single table', () => {
    expect(plan(['orders'])).toEqual([])
    expect(plan([])).toEqual([])
  })

  it('left-joins a table along the key that points from or to a table already joined', () => {
    expect(plan(['orders', 'customers'])).toEqual([
      'LEFT JOIN `d`.`customers` ON `customers`.`id` = `orders`.`customer_id`',
    ])
    // The other direction: the key lives in the table being joined.
    expect(plan(['customers', 'orders'])).toEqual([
      'LEFT JOIN `d`.`orders` ON `customers`.`id` = `orders`.`customer_id`',
    ])
  })

  it('joins a chain in the order given, and a table that only a later one reaches in a second pass', () => {
    expect(plan(['orders', 'items', 'customers'])).toEqual([
      'LEFT JOIN `d`.`items` ON `orders`.`id` = `items`.`order_id`',
      'LEFT JOIN `d`.`customers` ON `customers`.`id` = `orders`.`customer_id`',
    ])
    expect(plan(['items', 'customers', 'orders'])).toEqual([
      'LEFT JOIN `d`.`orders` ON `orders`.`id` = `items`.`order_id`',
      'LEFT JOIN `d`.`customers` ON `customers`.`id` = `orders`.`customer_id`',
    ])
  })

  it('matches the columns of a composite key pair by pair, joined with AND', () => {
    const schemas = new Map<string, TableSchema>([
      ['a', table(['x', 'y'])],
      ['b', table(['p', 'q'], [{ columns: ['p', 'q'], refTable: 'a', refColumns: ['x', 'y'] }])],
    ])
    expect(plan(['a', 'b'], schemas)).toEqual(['LEFT JOIN `d`.`b` ON `a`.`x` = `b`.`p` AND `a`.`y` = `b`.`q`'])
  })

  it('refuses a table no key reaches rather than cross-joining it, naming every such table', () => {
    refuses(() => plan(['orders', 'stray']), 'VALIDATION', /No foreign key connects stray to orders/)
    refuses(() => plan(['orders', 'stray', 'other']), 'VALIDATION', /connects stray, other to orders/)
  })

  it('does not follow a key into another database, nor a key to the table itself', () => {
    const schemas = new Map<string, TableSchema>([
      ['a', table(['id'])],
      ['b', table(['a_id'], [{ columns: ['a_id'], refTable: 'a', refColumns: ['id'], ref: { database: 'other' } }])],
      ['c', table(['c_id'], [{ columns: ['c_id'], refTable: 'c', refColumns: ['c_id'] }])],
    ])
    refuses(() => plan(['a', 'b'], schemas), 'VALIDATION', /No foreign key connects b to a/)
    refuses(() => plan(['c', 'a'], schemas), 'VALIDATION', /connects a to c/)
  })

  it('on MySQL ignores the schema of a key, and on PostgreSQL follows only a key into the same schema', () => {
    const schemas = (ref: Link['ref']) =>
      new Map<string, TableSchema>([
        ['a', table(['id'])],
        ['b', table(['a_id'], [{ columns: ['a_id'], refTable: 'a', refColumns: ['id'], ...(ref ? { ref } : {}) }])],
      ])
    const pgNs: Namespace = { database: 'd', schema: 's' }
    const pg = (ref: Link['ref'], ns: Namespace = pgNs) => joinPlan('postgres', ns, ['a', 'b'], schemas(ref))
    expect(pg({ database: 'd', schema: 's' })).toEqual(['LEFT JOIN "s"."b" ON "a"."id" = "b"."a_id"'])
    refuses(() => pg({ database: 'd', schema: 'other' }), 'VALIDATION', /No foreign key connects b to a/)
    // A schema left out is `public` on both sides.
    expect(pg({ database: 'd', schema: 'public' }, { database: 'd' })).toEqual([
      'LEFT JOIN "public"."b" ON "a"."id" = "b"."a_id"',
    ])
    expect(pg({ database: 'd' }, { database: 'd' })).toHaveLength(1)
    refuses(() => pg({ database: 'd', schema: 'other' }, { database: 'd' }), 'VALIDATION', /No foreign key/)
    expect(joinPlan('mysql', my, ['a', 'b'], schemas({ database: 'd', schema: 'ignored' }))).toHaveLength(1)
    refuses(() => pg({ database: 'x', schema: 's' }), 'VALIDATION', /No foreign key/)
  })

  it('knows no links for a table that was not described', () => {
    refuses(() => plan(['orders', 'customers'], new Map()), 'VALIDATION', /No foreign key connects customers to orders/)
  })
})

describe('joinPlan with joins spelled out', () => {
  const on = (from: [string, string], to: [string, string]) => ({
    from: { table: from[0], column: from[1] },
    to: { table: to[0], column: to[1] },
  })
  const join = (
    tableName: string,
    kind: QueryBuilderJoin['kind'],
    ...pairs: QueryBuilderJoin['on']
  ): QueryBuilderJoin => ({
    table: tableName,
    kind,
    on: pairs,
  })

  it('writes the join with its kind and its condition, instead of following a key', () => {
    expect(
      plan(['orders', 'customers'], shop, [
        join('customers', 'inner', on(['orders', 'customer_id'], ['customers', 'id'])),
      ])
    ).toEqual(['INNER JOIN `d`.`customers` ON `orders`.`customer_id` = `customers`.`id`'])
    for (const kind of ['left', 'right'] as const)
      expect(
        plan(['orders', 'customers'], shop, [
          join('customers', kind, on(['orders', 'customer_id'], ['customers', 'id'])),
        ])[0]
      ).toMatch(new RegExp(`^${kind.toUpperCase()} JOIN `))
    expect(
      plan(['orders', 'customers'], shop, [
        join(
          'customers',
          'inner',
          on(['orders', 'customer_id'], ['customers', 'id']),
          on(['orders', 'id'], ['customers', 'name'])
        ),
      ])[0]
    ).toBe(
      'INNER JOIN `d`.`customers` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`id` = `customers`.`name`'
    )
  })

  it('puts the joins spelled out first, then follows keys for the rest', () => {
    expect(
      plan(['orders', 'customers', 'items'], shop, [
        join('customers', 'right', on(['customers', 'id'], ['orders', 'customer_id'])),
      ])
    ).toEqual([
      'RIGHT JOIN `d`.`customers` ON `customers`.`id` = `orders`.`customer_id`',
      'LEFT JOIN `d`.`items` ON `orders`.`id` = `items`.`order_id`',
    ])
  })

  it('lets a later join use a table joined before it, and ignores a join for the first table or an unlisted one', () => {
    expect(
      plan(['orders', 'customers', 'items'], shop, [
        join('customers', 'inner', on(['orders', 'customer_id'], ['customers', 'id'])),
        join('items', 'left', on(['items', 'order_id'], ['orders', 'id'])),
      ])
    ).toHaveLength(2)
    expect(
      plan(['orders', 'customers'], shop, [join('orders', 'inner', on(['orders', 'id'], ['orders', 'id']))])
    ).toEqual(['LEFT JOIN `d`.`customers` ON `customers`.`id` = `orders`.`customer_id`'])
    expect(
      plan(['orders', 'customers'], shop, [join('items', 'inner', on(['items', 'id'], ['orders', 'id']))])
    ).toHaveLength(1)
  })

  it('refuses a condition on a column that does not exist', () => {
    refuses(
      () =>
        plan(['orders', 'customers'], shop, [join('customers', 'inner', on(['orders', 'nope'], ['customers', 'id']))]),
      'NOT_FOUND',
      /Unknown column in the join of customers/
    )
    refuses(
      () =>
        plan(['orders', 'customers'], shop, [
          join('customers', 'inner', on(['orders', 'customer_id'], ['customers', 'nope'])),
        ]),
      'NOT_FOUND',
      /Unknown column in the join of customers/
    )
    refuses(
      () => plan(['orders', 'customers'], shop, [join('customers', 'inner', on(['ghost', 'id'], ['customers', 'id']))]),
      'NOT_FOUND',
      /Unknown column/
    )
  })

  it('refuses a condition that leaves out the table, or reaches a table not joined before it', () => {
    refuses(
      () =>
        plan(['orders', 'customers'], shop, [
          join('customers', 'inner', on(['orders', 'id'], ['orders', 'customer_id'])),
        ]),
      'VALIDATION',
      /must use customers and a table joined before it/
    )
    refuses(
      () =>
        plan(['orders', 'customers', 'items'], shop, [
          join('customers', 'inner', on(['customers', 'id'], ['items', 'order_id'])),
        ]),
      'VALIDATION',
      /The join of customers must use customers and a table joined before it/
    )
  })

  it('refuses a condition that names the table second and, first, a table not joined before it', () => {
    refuses(
      () =>
        plan(['orders', 'customers', 'items'], shop, [
          join('customers', 'inner', on(['items', 'order_id'], ['customers', 'id'])),
        ]),
      'VALIDATION',
      /must use customers and a table joined before it/
    )
  })

  it('accepts a condition between two columns of the joined table itself', () => {
    expect(
      plan(['orders', 'customers'], shop, [join('customers', 'inner', on(['customers', 'id'], ['customers', 'name']))])
    ).toEqual(['INNER JOIN `d`.`customers` ON `customers`.`id` = `customers`.`name`'])
  })
})
