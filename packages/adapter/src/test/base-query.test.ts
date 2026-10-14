import { describe, expect, it } from 'vitest'
import type { MysqlAdapter } from '../mysql/adapter.ts'
import { column, type Dialect, ns, rig } from './base-rig.ts'

/**
 * `buildQuery` (the statement the query builder writes, to open in the SQL tab) and the INSERT with no values, for both
 * dialects, with the tables' descriptions supplied directly.
 */

type Spec = Parameters<MysqlAdapter['buildQuery']>[1]

const adapterFor = (
  dialect: Dialect,
  tables: Record<string, string[]> = { orders: ['id', 'total'] },
  types: Record<string, string> = {}
) =>
  rig(dialect, {
    table: (table) => ({ columns: (tables[table] ?? []).map((c) => column(c, types[`${table}.${c}`])) }),
  }).adapter
const spec = (over: Partial<Spec> = {}): Spec =>
  ({ tables: ['orders'], columns: [], where: [], joins: [], distinct: false, whereSql: '', ...over }) as Spec
const build = async (dialect: Dialect, s: Spec, tables?: Record<string, string[]>, types?: Record<string, string>) =>
  (await adapterFor(dialect, tables, types).buildQuery(ns, s)).sql
const col = (name: string, over: Record<string, unknown> = {}) =>
  ({
    table: 'orders',
    column: name,
    alias: '',
    show: true,
    sort: null,
    ...over,
  }) as Spec['columns'][number]
const cond = (name: string, op: string, value?: string) =>
  ({
    table: 'orders',
    column: name,
    op,
    ...(value !== undefined ? { value } : {}),
  }) as Spec['where'][number][number]

describe('BaseAdapter.buildQuery', () => {
  it('selects everything from the table when no column is shown', async () => {
    expect(await build('mysql', spec())).toBe('SELECT *\nFROM `d`.`orders`')
    expect(await build('postgres', spec())).toBe('SELECT *\nFROM "sales"."orders"')
    expect(await build('mysql', spec({ columns: [col('id', { show: false })] }))).toBe('SELECT *\nFROM `d`.`orders`')
  })

  it('lists the shown columns qualified by the table, with their aliases, and DISTINCT when asked', async () => {
    const s = spec({ columns: [col('id'), col('total', { alias: 'sum' }), col('id', { show: false })], distinct: true })
    expect(await build('mysql', s)).toBe('SELECT DISTINCT `orders`.`id`, `orders`.`total` AS `sum`\nFROM `d`.`orders`')
    expect(await build('postgres', spec({ columns: [col('id')] }))).toBe('SELECT "orders"."id"\nFROM "sales"."orders"')
  })

  it('orders by the columns that have a direction, whether or not they are shown', async () => {
    const s = spec({
      columns: [col('id', { sort: 'desc' }), col('total', { sort: 'asc', show: false }), col('id', { sort: null })],
    })
    expect(await build('mysql', s)).toBe(
      'SELECT `orders`.`id`, `orders`.`id`\nFROM `d`.`orders`\nORDER BY `orders`.`id` DESC, `orders`.`total` ASC'
    )
    expect(await build('mysql', spec({ columns: [col('id')] }))).not.toContain('ORDER BY')
  })

  it('adds LIMIT only when one is given, 0 included', async () => {
    expect(await build('mysql', spec({ limit: 25 }))).toBe('SELECT *\nFROM `d`.`orders`\nLIMIT 25')
    expect(await build('mysql', spec({ limit: 0 }))).toContain('\nLIMIT 0')
    expect(await build('mysql', spec({ limit: null }))).not.toContain('LIMIT')
  })

  it('writes one group of conditions joined by AND, and several groups joined by OR in parentheses', async () => {
    const one = spec({ where: [[cond('id', 'eq', '5'), cond('total', 'gt', '10')]] })
    expect(await build('mysql', one)).toBe(
      "SELECT *\nFROM `d`.`orders`\nWHERE `orders`.`id` = '5' AND `orders`.`total` > '10'"
    )
    const many = spec({ where: [[cond('id', 'eq', '1'), cond('total', 'gt', '2')], [cond('id', 'eq', '3')]] })
    expect(await build('mysql', many)).toBe(
      "SELECT *\nFROM `d`.`orders`\nWHERE (`orders`.`id` = '1' AND `orders`.`total` > '2') OR (`orders`.`id` = '3')"
    )
  })

  it('puts the typed SQL in parentheses of its own, trimmed, so an OR in it cannot escape the AND', async () => {
    expect(await build('mysql', spec({ whereSql: '  a = 1 OR b = 2 \n' }))).toBe(
      'SELECT *\nFROM `d`.`orders`\nWHERE (a = 1 OR b = 2)'
    )
    expect(await build('mysql', spec({ whereSql: '   ' }))).toBe('SELECT *\nFROM `d`.`orders`')
    const one = spec({ where: [[cond('id', 'eq', '1')]], whereSql: 'x OR y' })
    expect(await build('mysql', one)).toContain("WHERE `orders`.`id` = '1' AND (x OR y)")
    const many = spec({ where: [[cond('id', 'eq', '1')], [cond('id', 'eq', '2')]], whereSql: 'x OR y' })
    expect(await build('mysql', many)).toContain("WHERE ((`orders`.`id` = '1') OR (`orders`.`id` = '2')) AND (x OR y)")
  })

  it('refuses a table listed twice, and a column the table does not have', async () => {
    await expect(build('mysql', spec({ tables: ['orders', 'orders'] }))).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Each table can be listed only once',
    })
    await expect(build('mysql', spec({ columns: [col('nope')] }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Unknown column: orders.nope',
    })
    await expect(build('mysql', spec({ where: [[cond('nope', 'eq', '1')]] }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(build('mysql', spec({ columns: [col('nope', { show: false, sort: 'asc' })] }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('writes a BIT comparison in MySQL as the bytes it is held in, but not in PostgreSQL and not for a text operator', async () => {
    const types = { 'orders.flags': 'bit(8)' }
    const tables = { orders: ['flags'] }
    const eq = spec({ where: [[cond('flags', 'eq', '170')]] })
    expect(await build('mysql', eq, tables, types)).toContain("X'aa'")
    expect(await build('postgres', eq, tables, { 'orders.flags': 'bit(8)' })).toContain(`"orders"."flags" = '170'`)
    const like = spec({ where: [[cond('flags', 'contains', '17')]] })
    expect(await build('mysql', like, tables, types)).not.toContain("X'")
    // A type that only starts with the word is not BIT: the value is neither a bit literal nor converted.
    const bitmap = await build('mysql', eq, tables, { 'orders.flags': 'bitmap' })
    expect(bitmap).toContain("`orders`.`flags` = '170'")
    expect(bitmap).not.toContain('HEX(')
    expect(await build('mysql', eq, tables, { 'orders.flags': 'BIT(1)' })).toContain("X'aa'")
  })
})

describe('an INSERT with no values', () => {
  it('writes empty parentheses for MySQL and DEFAULT VALUES for PostgreSQL', () => {
    expect(adapterFor('mysql').insertPreview(ns, 't', {}).sql).toBe('INSERT INTO `d`.`t` () VALUES ()')
    expect(adapterFor('postgres').insertPreview(ns, 't', {}).sql).toBe('INSERT INTO "sales"."t" DEFAULT VALUES')
  })

  it('keeps the verb for ignore, and gives PostgreSQL ON CONFLICT DO NOTHING', () => {
    expect(adapterFor('mysql').insertPreview(ns, 't', {}, { ignore: true }).sql).toBe(
      'INSERT IGNORE INTO `d`.`t` () VALUES ()'
    )
    expect(adapterFor('postgres').insertPreview(ns, 't', {}, { ignore: true }).sql).toBe(
      'INSERT INTO "sales"."t" DEFAULT VALUES ON CONFLICT DO NOTHING'
    )
    expect(adapterFor('postgres').insertPreview(ns, 't', { a: 1 }, { ignore: true }).sql).toBe(
      'INSERT INTO "sales"."t" ("a") VALUES ($1) ON CONFLICT DO NOTHING'
    )
    expect(adapterFor('postgres').insertPreview(ns, 't', { a: 1 }).sql).not.toContain('CONFLICT')
  })
})
