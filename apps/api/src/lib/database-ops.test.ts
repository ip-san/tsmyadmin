import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import type { TriggerInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { DatabaseOpRefused, prepareDatabaseOp } from './database-ops.ts'

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
    if (err instanceof DatabaseOpRefused) return { code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

describe('prepareDatabaseOp', () => {
  const server = { database: 'information_schema' }

  it('lists the tables to move from the server, ignoring any list the request carried', async () => {
    // The request names one table; the database has two. Trusting it would drop `users` with the old database.
    const op = await prepareDatabaseOp(mysql(), server, {
      op: 'renameDatabase',
      name: 'shop',
      newName: 'store',
      tables: ['orders'],
      collation: 'latin1_bin',
    })
    expect(op.op === 'renameDatabase' && [...(op.tables ?? [])].sort()).toEqual(['orders', 'users'])
    // Collation comes from the server too (the fake reports none), not from the request.
    expect(op.collation).toBeUndefined()
  })

  it('refuses a MySQL rename that would lose views, routines, triggers or events', async () => {
    expect(
      await refusal(
        prepareDatabaseOp(mysql({ view: true }), server, { op: 'renameDatabase', name: 'shop', newName: 'store' })
      )
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('1 views') })
    expect(
      await refusal(
        prepareDatabaseOp(mysql({ routines: { f: 'SELECT 1' } }), server, {
          op: 'renameDatabase',
          name: 'shop',
          newName: 'store',
        })
      )
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('1 routines') })
    const withTrigger = mysql()
    withTrigger.listTriggers = async () => [{ name: 't' } as TriggerInfo]
    expect(
      await refusal(prepareDatabaseOp(withTrigger, server, { op: 'renameDatabase', name: 'shop', newName: 'store' }))
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('1 triggers') })
  })

  it('names a MariaDB sequence as a sequence, not as a view', async () => {
    const a = mysql()
    const seq = fakeTable('order_seq', ['id'], [])
    seq.schema.kind = 'sequence'
    const shop = (a as unknown as { databases: Record<string, { tables: Record<string, unknown> }> }).databases.shop
    if (shop) shop.tables.order_seq = seq
    const r = await refusal(prepareDatabaseOp(a, server, { op: 'renameDatabase', name: 'shop', newName: 'store' }))
    expect(r.message).toContain('1 sequences')
    expect(r.message).not.toContain('views')
  })

  it('describes an existing target with no tables without calling it empty', async () => {
    // It may be what a MySQL rename left behind, still holding routines or events this account cannot see.
    expect(
      await refusal(prepareDatabaseOp(mysql(), server, { op: 'renameDatabase', name: 'shop', newName: 'taken' }))
    ).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('no tables visible to this account') })
  })

  it('copies base tables with their writable columns, and does not refuse for views', async () => {
    const op = await prepareDatabaseOp(mysql({ view: true }), server, {
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

  it('refuses the same name, an existing target, a missing source and the server’s own databases', async () => {
    const a = mysql()
    expect(
      await refusal(prepareDatabaseOp(a, server, { op: 'renameDatabase', name: 'shop', newName: 'shop' }))
    ).toMatchObject({
      code: 'VALIDATION',
    })
    expect(
      await refusal(
        prepareDatabaseOp(a, server, { op: 'copyDatabase', name: 'shop', newName: 'taken', withData: true })
      )
    ).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('already exists'),
    })
    expect(
      await refusal(prepareDatabaseOp(a, server, { op: 'renameDatabase', name: 'nope', newName: 'x' }))
    ).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(
      await refusal(prepareDatabaseOp(a, server, { op: 'renameDatabase', name: 'MySQL', newName: 'x' }))
    ).toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('refuses, on PostgreSQL, the database the session is connected through', async () => {
    const pg = new FakeAdapter({ dialect: 'postgres', databases: { app: { tables: {} }, other: { tables: {} } } })
    expect(
      await refusal(prepareDatabaseOp(pg, { database: 'app' }, { op: 'renameDatabase', name: 'app', newName: 'x' }))
    ).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('connected through'),
    })
    // Any other database is renamed in place, with nothing to fill in.
    expect(
      await prepareDatabaseOp(pg, { database: 'app' }, { op: 'renameDatabase', name: 'other', newName: 'x' })
    ).toEqual({
      op: 'renameDatabase',
      name: 'other',
      newName: 'x',
    })
  })
})
