import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, type FakeDatabase, fakeTable } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { comparableDefinition, compareDefinitions, currentSchema, recordingDefinitions } from './snapshot-diff.ts'
import { SnapshotStore, takeSnapshot } from './snapshots.ts'

const NS = { database: 'shop' }
const state = (definitions: Record<string, string | null>) => ({
  names: new Set(Object.keys(definitions)),
  definitions: new Map(Object.entries(definitions).filter((e): e is [string, string] => e[1] !== null)) as ReadonlyMap<
    string,
    string
  >,
})

describe('comparableDefinition', () => {
  it('joins the statements as the change tracking does', () => {
    expect(comparableDefinition(['CREATE TABLE t (id int)', 'CREATE INDEX i ON t (id)'])).toBe(
      'CREATE TABLE t (id int);\nCREATE INDEX i ON t (id)'
    )
  })

  it("leaves out MySQL's next AUTO_INCREMENT value, which moves with every insert", () => {
    const create = (n: number) =>
      `CREATE TABLE \`t\` (\n  \`id\` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB AUTO_INCREMENT=${n} DEFAULT CHARSET=utf8mb4`
    expect(comparableDefinition([create(3)])).toBe(comparableDefinition([create(4000)]))
    // The column attribute stays; only the table option goes.
    expect(comparableDefinition([create(3)])).toContain('`id` int NOT NULL AUTO_INCREMENT,')
    expect(comparableDefinition([create(3)])).toContain(') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')
  })

  it("leaves out a sequence's position: PostgreSQL's setval and MariaDB's RESTART WITH", () => {
    expect(comparableDefinition(['CREATE SEQUENCE s START WITH 1', "SELECT pg_catalog.setval('s', 42, true)"])).toBe(
      'CREATE SEQUENCE s START WITH 1'
    )
    expect(comparableDefinition(['CREATE SEQUENCE `s` start with 1', 'ALTER SEQUENCE `s` RESTART WITH 7'])).toBe(
      'CREATE SEQUENCE `s` start with 1'
    )
  })

  it('keeps what is part of the schema', () => {
    const create = "CREATE TABLE t (n int) COMMENT='AUTO_INCREMENT=5'"
    expect(comparableDefinition([create])).toBe(create)
  })
})

describe('compareDefinitions', () => {
  it('tells added, removed, changed and unchanged apart, each list by name', () => {
    const diff = compareDefinitions(
      state({ z_same: 'S', a_changed: 'A1', gone: 'G', b_changed: 'B1' }),
      state({ z_same: 'S', a_changed: 'A2', b_changed: 'B2', made: 'M' })
    )
    expect(diff).toEqual({
      added: [{ name: 'made', before: null, after: 'M' }],
      removed: [{ name: 'gone', before: 'G', after: null }],
      changed: [
        { name: 'a_changed', before: 'A1', after: 'A2' },
        { name: 'b_changed', before: 'B1', after: 'B2' },
      ],
      unchanged: 1,
      unreadable: [],
    })
  })

  it('does not compare what one side could not read, and still lists what was added or removed without it', () => {
    const diff = compareDefinitions(state({ v: null, w: 'W', gone: null }), state({ v: 'V', w: null, made: null }))
    expect(diff.unreadable).toEqual(['v', 'w'])
    expect(diff.added).toEqual([{ name: 'made', before: null, after: null }])
    expect(diff.removed).toEqual([{ name: 'gone', before: null, after: null }])
    expect(diff.unchanged).toBe(0)
    expect(diff.changed).toEqual([])
  })

  it('finds nothing between two equal states', () => {
    const s = state({ a: 'A', b: 'B' })
    expect(compareDefinitions(s, s)).toMatchObject({ added: [], removed: [], changed: [], unchanged: 2 })
  })
})

function shop(): { adapter: FakeAdapter; db: FakeDatabase } {
  const db: FakeDatabase = {
    tables: {
      users: fakeTable('users', ['id', 'name'], [{ id: 1, name: 'Alice' }]),
      posts: fakeTable('posts', ['id', 'title'], []),
    },
  }
  return { adapter: new FakeAdapter({ databases: { shop: db } }), db }
}

describe('currentSchema', () => {
  it('reads every object of the namespace through the adapter', async () => {
    const { adapter } = shop()
    const now = await currentSchema(adapter, NS)
    expect([...now.names].sort()).toEqual(['posts', 'users'])
    expect(now.definitions.get('users')).toBe('-- fake CREATE TABLE users (id, name)')
  })

  it('lists a view it may not SHOW without a definition, and leaves out one dropped while it reads', async () => {
    const { adapter } = shop()
    const read = adapter.showCreateTable.bind(adapter)
    adapter.showCreateTable = async (ns, table) => {
      if (table === 'users') throw new AdapterError('PERMISSION_DENIED', 'SHOW VIEW command denied')
      if (table === 'posts') throw new AdapterError('NOT_FOUND', 'gone')
      return read(ns, table)
    }
    const now = await currentSchema(adapter, NS)
    expect([...now.names]).toEqual(['users'])
    expect(now.definitions.size).toBe(0)
  })

  it('lets any other failure through', async () => {
    const { adapter } = shop()
    adapter.showCreateTable = async () => {
      throw new AdapterError('CONNECTION_FAILED', 'lost')
    }
    await expect(currentSchema(adapter, NS)).rejects.toThrow('lost')
  })
})

describe('recordingDefinitions', () => {
  it('records what showCreateTable answers, and is the adapter itself for everything else', async () => {
    const { adapter } = shop()
    const { adapter: recording, definitions } = recordingDefinitions(adapter)
    expect(await recording.showCreateTable(NS, 'users')).toEqual(['-- fake CREATE TABLE users (id, name)'])
    expect(definitions).toEqual(new Map([['users', '-- fake CREATE TABLE users (id, name)']]))
    // Methods run on the adapter, not on the proxy.
    expect((await recording.listTables(NS)).map((t) => t.name).sort()).toEqual(['posts', 'users'])
    expect(recording.dialect).toBe('mysql')
  })

  it('lets a snapshot keep every definition its dump read, without reading them a second time', async () => {
    const { adapter } = shop()
    const store = new SnapshotStore({ sweepIntervalMs: 0 })
    const taken = await takeSnapshot(store, 's', adapter, NS, 'n')
    const held = store.get('s', taken.id)
    expect(held?.definitions).toEqual(
      new Map([
        ['posts', '-- fake CREATE TABLE posts (id, title)'],
        ['users', '-- fake CREATE TABLE users (id, name)'],
      ])
    )
    expect(adapter.calls.filter((c) => c.method === 'showCreateTable')).toHaveLength(2)
    // What it takes in memory counts the definitions as well as the dump.
    expect(taken.bytes).toBeGreaterThan(Buffer.byteLength(held?.sql ?? ''))
  })
})
