import { DELETE_IMPACT_MAX_DEPTH, type RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import type { Conn } from '../driver.ts'
import type { ConditionHooks } from './conditions.ts'
import { DELETE_IMPACT_MAX_STEPS, deleteImpactOn, walkDeleteImpact } from './delete-impact.ts'

const ns = { database: 'app' }
const key = (
  table: string,
  refTable: string,
  onDelete: string | null,
  extra: Partial<RelationDef> = {}
): RelationDef => ({
  table,
  name: `fk_${table}_${refTable}`,
  columns: [`${refTable}_id`],
  refNamespace: ns,
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete,
  ...extra,
})

/** Counts by the table the outermost SELECT reads: `rows[table]`, or 1. */
function counter(rows: Record<string, number> = {}) {
  const seen: string[] = []
  const count = async (sql: string) => {
    seen.push(sql)
    const table = /^SELECT COUNT\(\*\) FROM `[^`]+`\.`([^`]+)`/.exec(sql)?.[1] ?? ''
    return rows[table] ?? 1
  }
  return { seen, count }
}
const walk = (relations: RelationDef[], count: (sql: string) => Promise<number>, table = 'users') =>
  walkDeleteImpact({ dialect: 'mysql', ns, table, relations, where: '`id` = ?', count })

describe('walkDeleteImpact', () => {
  it('nests the condition of the rows above into each count', async () => {
    const { seen, count } = counter()
    await walk([key('orders', 'users', 'CASCADE'), key('items', 'orders', 'CASCADE')], count)
    expect(seen).toEqual([
      'SELECT COUNT(*) FROM `app`.`users` WHERE `id` = ?',
      'SELECT COUNT(*) FROM `app`.`orders` WHERE `users_id` IN (SELECT `id` FROM `app`.`users` WHERE `id` = ?)',
      'SELECT COUNT(*) FROM `app`.`items` WHERE `orders_id` IN (SELECT `id` FROM `app`.`orders` WHERE `users_id` IN (SELECT `id` FROM `app`.`users` WHERE `id` = ?))',
    ])
  })

  it('compares a composite key as a row', async () => {
    const { seen, count } = counter()
    await walk([key('lines', 'users', 'CASCADE', { columns: ['a', 'b'], refColumns: ['x', 'y'] })], count)
    expect(seen[1]).toBe(
      'SELECT COUNT(*) FROM `app`.`lines` WHERE (`a`, `b`) IN (SELECT `x`, `y` FROM `app`.`users` WHERE `id` = ?)'
    )
  })

  it('asks nothing more when no row matches the keys', async () => {
    const { seen, count } = counter({ users: 0 })
    const impact = await walk([key('orders', 'users', 'CASCADE')], counter({ users: 0 }).count)
    expect(impact).toEqual({ table: 'users', rows: 0, steps: [], blocked: false, capped: false })
    await walk([key('orders', 'users', 'CASCADE')], count)
    expect(seen).toHaveLength(1)
  })

  it('is blocked by RESTRICT or NO ACTION only when rows refer', async () => {
    const restricted = await walk([key('orders', 'users', 'RESTRICT')], counter({ orders: 0 }).count)
    expect(restricted.blocked).toBe(false)
    const noAction = await walk([key('orders', 'users', null)], counter().count)
    expect(noAction).toMatchObject({ blocked: true, steps: [{ action: 'noAction', rows: 1 }] })
  })

  it('does not follow SET NULL, SET DEFAULT or a refusing key further', async () => {
    const relations = ['SET NULL', 'SET DEFAULT', 'RESTRICT'].flatMap((rule, i) => [
      key(`t${i}`, 'users', rule),
      key(`u${i}`, `t${i}`, 'CASCADE'),
    ])
    const impact = await walk(relations, counter().count)
    expect(impact.steps.map((s) => s.table)).toEqual(['t0', 't1', 't2'])
  })

  it('ignores keys from another namespace', async () => {
    const other = key('audit', 'users', 'CASCADE', { refNamespace: { database: 'other' } })
    expect((await walk([other], counter().count)).steps).toEqual([])
  })

  it('tells a PostgreSQL schema from another, public when none is named', async () => {
    const elsewhere = key('a', 'users', 'CASCADE', { refNamespace: { database: 'app', schema: 'sales' } })
    const home = key('b', 'users', 'CASCADE', { refNamespace: { database: 'app', schema: 'public' } })
    const impact = await walkDeleteImpact({
      dialect: 'postgres',
      ns,
      table: 'users',
      relations: [elsewhere, home],
      where: '"id" = $1',
      count: async () => 1,
    })
    expect(impact.steps.map((s) => s.table)).toEqual(['b'])
  })

  it('stops at the depth limit and says so', async () => {
    const impact = await walk([key('users', 'users', 'CASCADE')], counter().count)
    expect(impact.steps).toHaveLength(DELETE_IMPACT_MAX_DEPTH)
    expect(impact.capped).toBe(true)
  })

  it('stops after the most keys it follows, and says so', async () => {
    // Two keys from every table to the next: the paths double at each depth.
    const relations = Array.from({ length: 10 }, (_, i) => [
      key(`t${i + 1}`, i === 0 ? 'users' : `t${i}`, 'CASCADE', { name: `a${i}` }),
      key(`t${i + 1}`, i === 0 ? 'users' : `t${i}`, 'CASCADE', { name: `b${i}` }),
    ]).flat()
    const impact = await walk(relations, counter().count)
    expect(impact.steps).toHaveLength(DELETE_IMPACT_MAX_STEPS)
    expect(impact.capped).toBe(true)
  })

  it('blocks only on a refusing key: rows set to NULL or deleted along do not stop the delete', async () => {
    const impact = await walk([key('notes', 'users', 'SET NULL'), key('orders', 'users', 'CASCADE')], counter().count)
    expect(impact.steps.map((s) => s.rows)).toEqual([1, 1, 1].slice(0, impact.steps.length))
    expect(impact.blocked).toBe(false)
    const restrict = await walk([key('orders', 'users', 'RESTRICT')], counter().count)
    expect(restrict.blocked).toBe(true)
  })
})

describe('deleteImpactOn', () => {
  const hooks: ConditionHooks = {
    dialect: 'postgres',
    keyParam: (p) => p,
    keyMatchExpr: (e) => e,
    nullSafeEq: () => 'IS NOT DISTINCT FROM',
  }

  it('picks every key with OR, binding their values once for each count', async () => {
    const asked: { sql: string; values: unknown[] | undefined }[] = []
    const conn = {
      query: async (sql: string, values?: unknown[]) => {
        asked.push({ sql, values })
        return { columns: [], rows: [['2']], affectedRows: 0, hasRows: true }
      },
    } as unknown as Conn
    const impact = await deleteImpactOn(conn, {
      hooks,
      ns,
      table: 'users',
      keys: [
        { kind: 'pk', values: { id: 1 } },
        { kind: 'pk', values: { id: 2 } },
      ],
      types: new Map(),
      relations: [key('orders', 'users', 'SET NULL')],
    })
    expect(asked[0]).toEqual({
      sql: 'SELECT COUNT(*) FROM "public"."users" WHERE ("id" = $1) OR ("id" = $2)',
      values: [1, 2],
    })
    expect(asked[1]?.sql).toContain('IN (SELECT "id" FROM "public"."users" WHERE ("id" = $1) OR ("id" = $2))')
    expect(asked[1]?.values).toEqual([1, 2])
    expect(impact).toMatchObject({ rows: 2, steps: [{ table: 'orders', rows: 2 }] })
  })
})
