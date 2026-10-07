import { type ConnectRequest, type Namespace, TRACKED_STATEMENT_MAX, type TrackKind } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import type { SavedItem, SavedItems } from '../session/store.ts'
import { recordGridChange, recordStatements, setTrackedKinds, trackedKinds, trackedStatements } from './tracking-log.ts'

/** A store that keeps what it is given in memory, one list per kind, and can be made to fail. */
function memory(options: { failSave?: boolean; failList?: boolean } = {}) {
  const items: SavedItem[] = []
  let clock = 1_000
  const store = {
    async list(_config: unknown, kind: string) {
      if (options.failList) throw new Error('the store is down')
      return items.filter((i) => i.kind === kind)
    },
    async save(_config: unknown, kind: string, name: string, body: string) {
      if (options.failSave) throw new Error('the store is down')
      const at = clock++
      const existing = items.findIndex((i) => i.kind === kind && i.name === name)
      const item = { id: `id-${items.length}`, kind, name, body, at } as SavedItem
      if (existing >= 0) items[existing] = item
      else items.push(item)
      return items.filter((i) => i.kind === kind)
    },
  }
  return { store: store as unknown as SavedItems, items }
}

const config = { dialect: 'mysql', host: 'h', port: 1, user: 'alice', password: 'x' } as unknown as ConnectRequest
const ns = { database: 'shop' }
const logger = () => ({ log: vi.fn() })

describe('the tracked kinds of a table', () => {
  it('are kept per table and read back for the namespace they belong to, with the schema only when there is one', async () => {
    const { store, items } = memory()
    await setTrackedKinds(store, config, ns, 'orders', ['insert', 'update'])
    await setTrackedKinds(store, config, { database: 'shop', schema: 'app' }, 'orders', ['delete'])
    await setTrackedKinds(store, config, { database: 'other' }, 'orders', ['insert'])
    expect(JSON.parse(items[0]?.body ?? '{}')).toEqual({
      database: 'shop',
      table: 'orders',
      kinds: ['insert', 'update'],
    })
    expect(JSON.parse(items[1]?.body ?? '{}')).toMatchObject({ schema: 'app' })
    expect((await trackedKinds(store, config, ns)).get('orders')?.kinds).toEqual(['insert', 'update'])
    expect((await trackedKinds(store, config, { database: 'shop', schema: 'app' })).get('orders')?.kinds).toEqual([
      'delete',
    ])
  })

  it('are replaced, not added, when the same table is set again', async () => {
    const { store, items } = memory()
    await setTrackedKinds(store, config, ns, 'orders', ['insert'])
    await setTrackedKinds(store, config, ns, 'orders', ['delete'])
    expect(items.filter((i) => i.kind === 'trackconf')).toHaveLength(1)
    expect((await trackedKinds(store, config, ns)).get('orders')?.kinds).toEqual(['delete'])
  })

  it('leave out an item that is not valid JSON or does not have the shape', async () => {
    const { store, items } = memory()
    items.push({ id: 'a', kind: 'trackconf', name: 'a', body: 'not json', at: 1 } as SavedItem)
    items.push({ id: 'b', kind: 'trackconf', name: 'b', body: '{"table": 1}', at: 2 } as SavedItem)
    expect((await trackedKinds(store, config, ns)).size).toBe(0)
  })
})

describe('recordStatements', () => {
  const tracked = async (
    kinds: TrackKind[] = ['update', 'delete', 'insert'],
    space: Namespace = ns,
    table = 'orders'
  ) => {
    const m = memory()
    await setTrackedKinds(m.store, config, space, table, kinds)
    return m
  }
  const logged = (m: ReturnType<typeof memory>) =>
    m.items.filter((i) => i.kind === 'tracklog').map((i) => JSON.parse(i.body))

  it('records a statement of a kind the table tracks, with who ran it, and nothing for one it does not', async () => {
    const m = await tracked(['update'])
    await recordStatements(m.store, config, ns, ['UPDATE orders SET a = 1', 'DELETE FROM orders', 'SELECT 1'], 'mysql')
    expect(logged(m)).toMatchObject([
      { table: 'orders', kind: 'update', statement: 'UPDATE orders SET a = 1', truncated: false, by: 'alice' },
    ])
  })

  it('does nothing without a store, without statements, or when none is a tracked kind of statement', async () => {
    const m = await tracked()
    await recordStatements(undefined, config, ns, ['UPDATE orders SET a = 1'], 'mysql')
    await recordStatements(m.store, config, ns, [], 'mysql')
    await recordStatements(m.store, config, ns, ['SELECT * FROM orders'], 'mysql')
    expect(logged(m)).toEqual([])
  })

  it('matches a table named with a database on MySQL against that database', async () => {
    const m = await tracked(['update'], { database: 'other' })
    await recordStatements(m.store, config, ns, ['UPDATE other.orders SET a = 1', 'UPDATE orders SET a = 1'], 'mysql')
    expect(logged(m)).toMatchObject([{ database: 'other', table: 'orders' }])
  })

  it('matches a table named with a schema on PostgreSQL against that schema of the same database', async () => {
    const m = await tracked(['update'], { database: 'shop', schema: 'app' })
    await recordStatements(
      m.store,
      config,
      { database: 'shop', schema: 'public' },
      ['UPDATE app.orders SET a = 1'],
      'postgres'
    )
    expect(logged(m)).toMatchObject([{ database: 'shop', schema: 'app', table: 'orders' }])
  })

  it('cuts a statement longer than the limit and says it was cut', async () => {
    const m = await tracked(['update'])
    const long = `UPDATE orders SET a = '${'x'.repeat(TRACKED_STATEMENT_MAX)}'`
    await recordStatements(m.store, config, ns, [long], 'mysql')
    const [entry] = logged(m)
    expect(entry.truncated).toBe(true)
    expect(entry.statement).toHaveLength(TRACKED_STATEMENT_MAX)
  })

  it('reads the settings of a namespace once for several statements in it', async () => {
    const m = await tracked(['update'])
    const list = vi.spyOn(m.store, 'list')
    await recordStatements(
      m.store,
      config,
      ns,
      ['UPDATE orders SET a = 1', 'UPDATE orders SET a = 2', 'UPDATE orders SET a = 3'],
      'mysql'
    )
    expect(list.mock.calls.filter((c) => c[1] === 'trackconf')).toHaveLength(1)
    expect(logged(m)).toHaveLength(3)
  })

  it('never fails the statement: a store that is down is logged by event and database only', async () => {
    const m = memory({ failList: true })
    const log = logger()
    await expect(
      recordStatements(m.store, config, ns, ['UPDATE orders SET a = 1'], 'mysql', log)
    ).resolves.toBeUndefined()
    expect(log.log).toHaveBeenCalledWith('warn', 'tracking.log_failed', { database: 'shop' })
    await expect(recordStatements(m.store, config, ns, ['UPDATE orders SET a = 1'], 'mysql')).resolves.toBeUndefined()
  })
})

describe('recordGridChange', () => {
  const logged = (m: ReturnType<typeof memory>) =>
    m.items.filter((i) => i.kind === 'tracklog').map((i) => JSON.parse(i.body))

  it('records what was done to a tracked table — the kind, the number of rows, the columns — and never a value', async () => {
    const m = memory()
    await setTrackedKinds(m.store, config, ns, 'orders', ['update'])
    await recordGridChange(m.store, config, ns, 'orders', 'update', 2, ['a', 'b'])
    expect(logged(m)).toMatchObject([
      { table: 'orders', kind: 'update', statement: null, rows: 2, columns: ['a', 'b'], by: 'alice' },
    ])
  })

  it('does nothing for a kind the table does not track, a table that is not tracked, or no store', async () => {
    const m = memory()
    await setTrackedKinds(m.store, config, ns, 'orders', ['update'])
    await recordGridChange(m.store, config, ns, 'orders', 'delete', 1, [])
    await recordGridChange(m.store, config, ns, 'other', 'update', 1, [])
    await recordGridChange(undefined, config, ns, 'orders', 'update', 1, [])
    expect(logged(m)).toEqual([])
  })

  it('never fails the change: a store that is down is logged with the table', async () => {
    const m = memory({ failList: true })
    const log = logger()
    await expect(recordGridChange(m.store, config, ns, 'orders', 'update', 1, [], log)).resolves.toBeUndefined()
    expect(log.log).toHaveBeenCalledWith('warn', 'tracking.log_failed', { database: 'shop', table: 'orders' })
  })
})

describe('trackedStatements', () => {
  it('are the ones of one table of the namespace, newest first, and those of the same millisecond in the order written', async () => {
    const m = memory()
    await setTrackedKinds(m.store, config, ns, 'orders', ['update', 'delete'])
    await setTrackedKinds(m.store, config, ns, 'users', ['update'])
    await recordStatements(m.store, config, ns, ['UPDATE orders SET a = 1'], 'mysql')
    await recordStatements(m.store, config, ns, ['UPDATE users SET a = 1'], 'mysql')
    await recordStatements(m.store, config, ns, ['DELETE FROM orders'], 'mysql')
    m.items.push({ id: 'junk', kind: 'tracklog', name: 'junk', body: 'nope', at: 99_999 } as SavedItem)
    const out = await trackedStatements(m.store, config, ns, 'orders')
    expect(out.map((e) => e.kind)).toEqual(['delete', 'update'])
    expect(out[0]).not.toHaveProperty('order')
  })

  it('keep two written in the same millisecond in the order they were written', async () => {
    const m = memory()
    const body = (kind: string) =>
      JSON.stringify({ database: 'shop', table: 'orders', kind, statement: kind, truncated: false, by: 'a' })
    m.items.push({
      id: '1',
      kind: 'tracklog',
      name: '000000000001000-000001-a',
      body: body('insert'),
      at: 5,
    } as SavedItem)
    m.items.push({
      id: '2',
      kind: 'tracklog',
      name: '000000000001000-000002-a',
      body: body('update'),
      at: 5,
    } as SavedItem)
    const out = await trackedStatements(m.store, config, ns, 'orders')
    expect(out.map((e) => e.kind)).toEqual(['update', 'insert'])
  })
})
