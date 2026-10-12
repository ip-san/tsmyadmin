import { describe, expect, it } from 'vitest'
import { PostgresAdapter } from './adapter.ts'

/**
 * The parts of the PostgreSQL adapter that a real server answers one way: the list of databases, the names of the
 * types a result column has, and the reading of a result, each with the pool or the query scripted.
 */

const config = { dialect: 'postgres' as const, host: 'h', port: 1, user: 'u', password: 'p' }
type Internals = {
  poolFor: (database: string) => unknown
  columnMetas: (
    client: unknown,
    fields: { name: string; dataTypeID: number }[]
  ) => Promise<{ name: string; dataType: string }[]>
  toRaw: (client: unknown, res: unknown, options?: unknown) => Promise<unknown>
  run: (client: unknown, sql: string, params?: unknown[]) => Promise<unknown>
}
const internals = (a: PostgresAdapter) => a as unknown as Internals

describe('PostgresAdapter: what it says without asking', () => {
  it('names the database it signs in to, postgres when none was given, as the namespace of server-wide questions', () => {
    expect(new PostgresAdapter(config).serverNamespace).toEqual({ database: 'postgres' })
    expect(new PostgresAdapter({ ...config, database: 'shop' }).serverNamespace).toEqual({ database: 'shop' })
  })

  it("has no events or event details, and no database-level grants: those are MySQL's", async () => {
    const a = new PostgresAdapter(config)
    expect(await a.listEvents({ database: 'd' })).toEqual([])
    expect(await a.eventDetail({ database: 'd' }, 'e')).toBeNull()
    expect(await a.databaseGrants('d')).toEqual([])
  })
})

describe('PostgresAdapter.listDatabases', () => {
  const adapter = (answer: () => Promise<{ rows: { datname: string; size: string | null }[] }>) => {
    const a = new PostgresAdapter({ ...config, database: 'home' })
    const asked: { database: string; sql: string; params: unknown[] }[] = []
    internals(a).poolFor = (database: string) => ({
      query: async (sql: string, params: unknown[]) => {
        asked.push({ database, sql, params })
        return await answer()
      },
    })
    return { a, asked }
  }

  it('lists each database with its size, none where the account may not connect, and no table count or collation', async () => {
    const { a, asked } = adapter(async () => ({
      rows: [
        { datname: 'a', size: '8192' },
        { datname: 'b', size: null },
        { datname: 'c', size: '0' },
      ],
    }))
    expect(await a.listDatabases()).toEqual([
      { name: 'a', sizeBytes: 8192, tableCount: null, collation: null },
      { name: 'b', sizeBytes: null, tableCount: null, collation: null },
      { name: 'c', sizeBytes: 0, tableCount: null, collation: null },
    ])
    expect(asked[0]?.database).toBe('home')
    expect(asked[0]?.params).toEqual([true])
    expect(asked[0]?.sql).toContain('datistemplate = false ORDER BY datname')
  })

  it('asks for sizes unless told not to', async () => {
    const off = adapter(async () => ({ rows: [] }))
    await off.a.listDatabases({ stats: false })
    expect(off.asked[0]?.params).toEqual([false])
    const on = adapter(async () => ({ rows: [] }))
    await on.a.listDatabases({ stats: true })
    expect(on.asked[0]?.params).toEqual([true])
  })

  it('reports a failure of the server as an adapter error', async () => {
    const { a } = adapter(async () => {
      throw Object.assign(new Error('password authentication failed'), { code: '28P01' })
    })
    await expect(a.listDatabases()).rejects.toMatchObject({ code: 'AUTH_FAILED' })
  })
})

describe("PostgresAdapter: the types of a result's columns", () => {
  const field = (name: string, dataTypeID: number) => ({ name, dataTypeID })

  it('names the types it knows by their table, and an unknown one by a question to the server, once', async () => {
    const a = new PostgresAdapter(config)
    const asked: unknown[][] = []
    internals(a).run = async (_client, _sql, params) => {
      asked.push(params ?? [])
      return { columns: [], rows: [['600000', 'mytype']], affectedRows: 0, hasRows: true }
    }
    const metas = await internals(a).columnMetas({}, [
      field('n', 23),
      field('t', 25),
      field('x', 600000),
      field('y', 600000),
    ])
    expect(metas).toEqual([
      { name: 'n', dataType: 'int4' },
      { name: 't', dataType: 'text' },
      { name: 'x', dataType: 'mytype' },
      { name: 'y', dataType: 'mytype' },
    ])
    expect(asked).toEqual([[[600000]]])
    await internals(a).columnMetas({}, [field('x', 600000)])
    expect(asked).toHaveLength(1)
  })

  it('asks nothing when every type is known, and shows an oid the server could not name as oid:N', async () => {
    const a = new PostgresAdapter(config)
    let asks = 0
    internals(a).run = async () => {
      asks++
      return { columns: [], rows: [], affectedRows: 0, hasRows: true }
    }
    expect(await internals(a).columnMetas({}, [field('n', 23)])).toEqual([{ name: 'n', dataType: 'int4' }])
    expect(asks).toBe(0)
    expect(await internals(a).columnMetas({}, [field('z', 777)])).toEqual([{ name: 'z', dataType: 'oid:777' }])
    expect(asks).toBe(1)
    expect(await internals(a).columnMetas({}, [])).toEqual([])
  })

  it('asks about several unknown types in one question, each once', async () => {
    const a = new PostgresAdapter(config)
    const asked: unknown[][] = []
    internals(a).run = async (_c, _s, params) => {
      asked.push(params ?? [])
      return {
        columns: [],
        rows: [
          ['5001', 'a'],
          ['5002', 'b'],
        ],
        affectedRows: 0,
        hasRows: true,
      }
    }
    const metas = await internals(a).columnMetas({}, [field('p', 5001), field('q', 5002), field('r', 5001)])
    expect(metas.map((m) => m.dataType)).toEqual(['a', 'b', 'a'])
    expect(asked).toEqual([[[5001, 5002]]])
  })
})

describe('PostgresAdapter: a result as the wire has it', () => {
  const raw = async (res: unknown, options?: unknown) =>
    await internals(new PostgresAdapter(config)).toRaw({}, res, options)

  it('reads the columns and the rows as wire cells, a statement that returns rows having them even when empty', async () => {
    const out = await raw({
      fields: [
        { name: 'id', dataTypeID: 23 },
        { name: 'b', dataTypeID: 17 },
      ],
      rows: [
        [1, Buffer.from([1])],
        [2n, null],
      ],
      rowCount: 2,
    })
    expect(out).toEqual({
      columns: [
        { name: 'id', dataType: 'int4' },
        { name: 'b', dataType: 'bytea' },
      ],
      rows: [
        [1, { $bin: 'AQ==' }],
        ['2', null],
      ],
      affectedRows: 2,
      hasRows: true,
    })
    expect(await raw({ fields: [{ name: 'id', dataTypeID: 23 }], rows: [], rowCount: 0 })).toMatchObject({
      hasRows: true,
      rows: [],
      columns: [{ name: 'id' }],
    })
  })

  it('reads a statement with no result set as the number of rows it changed, none when the server did not say', async () => {
    expect(await raw({ fields: [], rows: [], rowCount: 5 })).toEqual({
      columns: [],
      rows: [],
      affectedRows: 5,
      hasRows: false,
    })
    expect(await raw({ fields: [], rows: [], rowCount: null })).toMatchObject({ affectedRows: 0, hasRows: false })
    expect(await raw({ fields: [], rows: [], rowCount: 0 })).toMatchObject({ affectedRows: 0 })
  })

  it('cuts the values to the limits it is given', async () => {
    const out = (await raw(
      { fields: [{ name: 't', dataTypeID: 25 }], rows: [['abcdef']], rowCount: 1 },
      { textLimit: 3 }
    )) as { rows: unknown[][] }
    expect(out.rows).toEqual([[{ $text: 'abc', length: 6 }]])
  })
})
