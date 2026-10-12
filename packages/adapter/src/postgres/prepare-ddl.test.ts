import { describe, expect, it } from 'vitest'
import { FakeAdapter } from '../testing/fake-adapter.ts'
import { AdapterError, type DatabaseAdapter } from '../types.ts'
import { pgPrepareDdl } from './prepare-ddl.ts'

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof AdapterError) return { code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

describe('pgPrepareDdl: a rename or copy of a whole database', () => {
  it('refuses, on PostgreSQL, the database the session is connected through', async () => {
    const pg = new FakeAdapter({
      dialect: 'postgres',
      serverNamespace: { database: 'app' },
      databases: { app: { tables: {} }, other: { tables: {} } },
    })
    expect(
      await refusal(pgPrepareDdl(pg, { database: 'app' }, { op: 'renameDatabase', name: 'app', newName: 'x' }))
    ).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('connected through'),
    })
    // Any other database is renamed in place, with nothing to fill in.
    expect(await pgPrepareDdl(pg, { database: 'app' }, { op: 'renameDatabase', name: 'other', newName: 'x' })).toEqual({
      op: 'renameDatabase',
      name: 'other',
      newName: 'x',
    })
  })
})

describe('pgPrepareDdl: a collation applied to the tables', () => {
  const adapterOf = (describe: (table: string) => unknown) =>
    ({
      listTables: async () => [
        { name: 'a', kind: 'table' },
        { name: 'gone', kind: 'table' },
        { name: 'v', kind: 'view' },
        { name: 's', kind: 'sequence' },
        { name: 'b', kind: 'table' },
      ],
      describeTable: async (_ns: unknown, table: string) => describe(table),
    }) as unknown as DatabaseAdapter
  const text = (name: string, dataType = 'text', generated: unknown = null) => ({ name, dataType, generated })
  const op = { op: 'setDatabaseCollation', name: 'db', collation: 'C', applyToTables: true } as const
  const ns = { database: 'db' }

  it('lists the tables and their text columns, generated and non-text ones left out', async () => {
    const adapter = adapterOf((table) => ({
      columns:
        table === 'a'
          ? [
              text('t'),
              text('n', 'integer'),
              text('g', 'text', { expression: 'x', stored: true }),
              text('c', 'CHARACTER VARYING(5)'),
              text('ci', 'citext'),
            ]
          : [text('only')],
    }))
    expect(await pgPrepareDdl(adapter, ns, op)).toMatchObject({
      tables: ['a', 'gone', 'b'],
      columns: {
        a: [
          { name: 't', dataType: 'text' },
          { name: 'c', dataType: 'CHARACTER VARYING(5)' },
          { name: 'ci', dataType: 'citext' },
        ],
        b: [{ name: 'only', dataType: 'text' }],
      },
    })
  })

  it('leaves out a table someone dropped between the list and the description, and goes on', async () => {
    const adapter = adapterOf((table) => {
      if (table === 'gone') throw new AdapterError('NOT_FOUND', 'Table not found: public.gone')
      return { columns: [text('t')] }
    })
    const out = (await pgPrepareDdl(adapter, ns, op)) as { tables: string[]; columns: Record<string, unknown> }
    expect(out.tables).toEqual(['a', 'b'])
    expect(Object.keys(out.columns)).toEqual(['a', 'b'])
  })

  it('does not hide any other failure', async () => {
    const adapter = adapterOf((table) => {
      if (table === 'gone') throw new AdapterError('QUERY_FAILED', 'boom')
      return { columns: [] }
    })
    expect(await refusal(pgPrepareDdl(adapter, ns, op))).toMatchObject({ code: 'QUERY_FAILED' })
    const plain = adapterOf((table) => {
      if (table === 'gone') throw new Error('not an adapter error')
      return { columns: [] }
    })
    await expect(pgPrepareDdl(plain, ns, op)).rejects.toThrow('not an adapter error')
  })

  it('returns the op as it came when it applies to no tables or already carries them', async () => {
    const adapter = adapterOf(() => ({ columns: [] }))
    expect(await pgPrepareDdl(adapter, ns, { ...op, applyToTables: false })).toEqual({ ...op, applyToTables: false })
    const given = { ...op, tables: ['x'] }
    expect(await pgPrepareDdl(adapter, ns, given)).toEqual(given)
  })
})
