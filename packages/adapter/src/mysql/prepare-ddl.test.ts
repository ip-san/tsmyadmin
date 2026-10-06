import type { TriggerInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { FakeAdapter, fakeTable } from '../testing/fake-adapter.ts'
import { AdapterError } from '../types.ts'
import { mysqlPrepareDdl } from './prepare-ddl.ts'

const withGenerated = () => {
  const t = fakeTable('orders', ['id', 'qty', 'total'], [])
  const total = t.schema.columns.find((c) => c.name === 'total')
  if (total) total.extra = 'STORED GENERATED'
  return t
}

function mysql(extra: { view?: boolean; routines?: Record<string, string> } = {}) {
  const view = fakeTable('active', ['id'], [])
  view.schema.kind = 'view'
  return new FakeAdapter({
    dialect: 'mysql',
    databases: {
      shop: {
        tables: {
          orders: withGenerated(),
          users: fakeTable('users', ['id'], []),
          ...(extra.view ? { active: view } : {}),
        },
      },
      taken: { tables: {} },
      mysql: { tables: {} },
    },
    ...(extra.routines ? { routines: extra.routines } : {}),
  })
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof AdapterError) return { code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

describe('mysqlPrepareDdl: a rename or copy of a whole database', () => {
  const server = { database: 'information_schema' }

  it('lists the tables to move from the server, ignoring any list the request carried', async () => {
    // The request names one table; the database has two. Trusting it would drop `users` with the old database.
    const op = await mysqlPrepareDdl(mysql(), server, {
      op: 'renameDatabase',
      name: 'shop',
      newName: 'store',
      tables: ['orders'],
      collation: 'latin1_bin',
    })
    expect(op.op === 'renameDatabase' && [...(op.tables ?? [])].sort()).toEqual(['orders', 'users'])
    // Collation comes from the server too (the fake reports none), not from the request.
    expect((op as { collation?: string }).collation).toBeUndefined()
  })

  it('refuses a MySQL rename that would lose views, routines, triggers or events', async () => {
    expect(
      await refusal(
        mysqlPrepareDdl(mysql({ view: true }), server, { op: 'renameDatabase', name: 'shop', newName: 'store' })
      )
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('1 views') })
    expect(
      await refusal(
        mysqlPrepareDdl(mysql({ routines: { f: 'SELECT 1' } }), server, {
          op: 'renameDatabase',
          name: 'shop',
          newName: 'store',
        })
      )
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('1 routines') })
    const withTrigger = mysql()
    withTrigger.listTriggers = async () => [{ name: 't' } as TriggerInfo]
    expect(
      await refusal(mysqlPrepareDdl(withTrigger, server, { op: 'renameDatabase', name: 'shop', newName: 'store' }))
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('1 triggers') })
  })

  it('names a MariaDB sequence as a sequence, not as a view', async () => {
    const a = mysql()
    const seq = fakeTable('order_seq', ['id'], [])
    seq.schema.kind = 'sequence'
    const shop = (a as unknown as { databases: Record<string, { tables: Record<string, unknown> }> }).databases.shop
    if (shop) shop.tables.order_seq = seq
    const r = await refusal(mysqlPrepareDdl(a, server, { op: 'renameDatabase', name: 'shop', newName: 'store' }))
    expect(r.message).toContain('1 sequences')
    expect(r.message).not.toContain('views')
  })

  it('describes an existing target with no tables without calling it empty', async () => {
    // It may be what a MySQL rename left behind, still holding routines or events this account cannot see.
    expect(
      await refusal(mysqlPrepareDdl(mysql(), server, { op: 'renameDatabase', name: 'shop', newName: 'taken' }))
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('no tables visible to this account') })
  })

  it('copies base tables with their writable columns, and does not refuse for views', async () => {
    const op = await mysqlPrepareDdl(mysql({ view: true }), server, {
      op: 'copyDatabase',
      name: 'shop',
      newName: 'store',
      withData: true,
    })
    expect(op.op === 'copyDatabase' && op.tables).toEqual([
      // A generated column cannot be inserted into, so it is left out of the INSERT … SELECT.
      { name: 'orders', columns: ['id', 'qty'] },
      { name: 'users', columns: ['id'] },
    ])
  })

  it('copies rows only into a target that has the same tables, and only the columns it has', async () => {
    const adapter = new FakeAdapter({
      dialect: 'mysql',
      databases: {
        shop: { tables: { orders: withGenerated(), users: fakeTable('users', ['id'], []) } },
        mirror: { tables: { orders: fakeTable('orders', ['id'], []), users: fakeTable('users', ['id'], []) } },
        partial: { tables: { users: fakeTable('users', ['id'], []) } },
        mysql: { tables: {} },
      },
    })
    const rowsOnly = (newName: string) =>
      mysqlPrepareDdl(adapter, server, {
        op: 'copyDatabase',
        name: 'shop',
        newName,
        withData: true,
        structure: false,
      })
    const op = await rowsOnly('mirror')
    // `qty` is not in the target's `orders`, and `total` is generated: neither is copied.
    expect(op.op === 'copyDatabase' && op.tables).toEqual([
      { name: 'orders', columns: ['id'] },
      { name: 'users', columns: ['id'] },
    ])
    expect(await refusal(rowsOnly('partial'))).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('has no table "orders"'),
    })
    expect(await refusal(rowsOnly('nowhere'))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses the same name, an existing target, a missing source and the server’s own databases', async () => {
    const a = mysql()
    expect(
      await refusal(mysqlPrepareDdl(a, server, { op: 'renameDatabase', name: 'shop', newName: 'shop' }))
    ).toMatchObject({
      code: 'VALIDATION',
    })
    expect(
      await refusal(mysqlPrepareDdl(a, server, { op: 'copyDatabase', name: 'shop', newName: 'taken', withData: true }))
    ).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('already exists'),
    })
    expect(
      await refusal(mysqlPrepareDdl(a, server, { op: 'renameDatabase', name: 'nope', newName: 'x' }))
    ).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(
      await refusal(mysqlPrepareDdl(a, server, { op: 'renameDatabase', name: 'MySQL', newName: 'x' }))
    ).toMatchObject({
      code: 'VALIDATION',
    })
  })
})
