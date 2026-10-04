import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import {
  AffectedRowsSchema,
  ApiErrorSchema,
  BrowseResultSchema,
  DdlPreviewResponseSchema,
  QueryBuilderResultSchema,
  RelationDefSchema,
  SEARCH_TERM_MAX,
  SqlCancelResponseSchema,
  SqlStreamEventSchema,
  StatementResultSchema,
  TableInfoSchema,
  TableSchemaSchema,
  TableSearchResultSchema,
  TableStatsSchema,
} from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeStoresAfterEach, fixtureAdapter, harness } from './test/app-harness.ts'

const stores = closeStoresAfterEach()

describe('databases & tables', () => {
  it('lists databases, schemas and tables (contract-checked)', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const dbs = (await (await h.req('/api/databases')).json()) as { name: string }[]
    expect(dbs.map((d) => d.name)).toEqual(['other', 'shop'])
    expect(await (await h.req('/api/databases/shop/schemas')).json()).toEqual([])
    const tables = z.array(TableInfoSchema).parse(await (await h.req('/api/databases/shop/tables')).json())
    expect(tables.map((t) => t.name)).toEqual(['users', 'posts'])
    const structure = TableSchemaSchema.parse(await (await h.req('/api/databases/shop/tables/users/structure')).json())
    expect(structure.primaryKey).toEqual(['id'])
  })

  it('lists routines and triggers (table filter passed through)', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/databases/shop/routines?schema=app')).json()).toEqual([])
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listRoutines', args: [{ database: 'shop', schema: 'app' }] })
    expect(await (await h.req('/api/databases/shop/routines/user_label/definition?kind=function')).json()).toEqual({
      definition: 'CREATE FUNCTION user_label() BEGIN END',
    })
    expect(h.adapter.calls.at(-1)).toEqual({
      method: 'routineDefinition',
      args: [{ database: 'shop' }, 'user_label', 'function'],
    })
    expect((await h.req('/api/databases/shop/routines/user_label/definition?kind=view')).status).toBe(400)
    expect(await (await h.req('/api/databases/shop/triggers?table=users')).json()).toEqual([])
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listTriggers', args: [{ database: 'shop' }, 'users'] })
    expect(await (await h.req('/api/databases/shop/events')).json()).toEqual([])
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listEvents', args: [{ database: 'shop' }] })
  })

  it('passes ?schema through as the namespace', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    await h.req('/api/databases/shop/tables?schema=app')
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'listTables', args: [{ database: 'shop', schema: 'app' }] })
  })

  it('answers unknown /api paths with the JSON NOT_FOUND envelope', async () => {
    const h = harness()
    stores.push(h.store)
    const res = await h.req('/api/no/such/route')
    expect(res.status).toBe(404)
    expect(ApiErrorSchema.parse(await res.json())).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the CREATE statements of a table', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/create')
    expect(res.status).toBe(200)
    expect(DdlPreviewResponseSchema.parse(await res.json()).sql[0]).toMatch(/CREATE TABLE/)
    expect(h.adapter.calls.at(-1)).toEqual({ method: 'showCreateTable', args: [{ database: 'shop' }, 'users'] })
  })

  it('returns 404 NOT_FOUND from the adapter', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/nope/structure')
    expect(res.status).toBe(404)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('NOT_FOUND')
  })
})

describe('rows', () => {
  it('browses with sort/filter/paging from the query string', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req(
      '/api/databases/shop/tables/users/rows?limit=2&offset=1&sort=name:desc&filters=' +
        encodeURIComponent('[{"column":"name","op":"like","value":"%o%"}]')
    )
    expect(res.status).toBe(200)
    const body = BrowseResultSchema.parse(await res.json())
    expect(body.rows).toEqual([[2, 'Bob']])
    expect(body.total).toBe(2)
    expect(h.adapter.calls.at(-1)?.args[2]).toEqual({
      offset: 1,
      limit: 2,
      sort: [{ column: 'name', direction: 'desc' }],
      filters: [{ column: 'name', op: 'like', value: '%o%' }],
    })
  })

  it('takes list operators with their values from the query string', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ids = async (filters: unknown) => {
      const res = await h.req(
        `/api/databases/shop/tables/users/rows?sort=id:asc&filters=${encodeURIComponent(JSON.stringify(filters))}`
      )
      expect(res.status).toBe(200)
      return BrowseResultSchema.parse(await res.json()).rows.map((r) => r[0])
    }
    expect(await ids([{ column: 'id', op: 'in', values: [1, '3'] }])).toEqual([1, 3])
    expect(await ids([{ column: 'id', op: 'not_between', values: ['2', 2] }])).toEqual([1, 3])
    expect(await ids([{ column: 'name', op: 'regexp', value: '^[AB]' }])).toEqual([1, 2])
  })

  it("reports a table's space and row statistics", async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/stats')
    expect(res.status).toBe(200)
    expect(TableStatsSchema.parse(await res.json())).toMatchObject({ rowEstimate: 3, dataBytes: 300 })
    expect((await h.req('/api/databases/shop/tables/nope/stats')).status).toBe(404)
  })

  it('hands one value over whole as a download', async () => {
    const h = harness(
      fixtureAdapter({
        databases: {
          shop: {
            tables: {
              files: fakeTable(
                'files',
                ['id', 'data'],
                [
                  { id: 1, data: { $bin: Buffer.from([0, 1, 255]).toString('base64') } },
                  { id: 2, data: null },
                ]
              ),
            },
          },
        },
      })
    )
    stores.push(h.store)
    await h.login()
    const url = (id: unknown, column = 'data') =>
      `/api/databases/shop/tables/files/cell?column=${column}&key=${encodeURIComponent(JSON.stringify(id))}`
    const res = await h.req(url({ kind: 'pk', values: { id: 1 } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('filename="files.data.bin"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 255])
    expect((await h.req(url({ kind: 'pk', values: { id: 2 } }))).status).toBe(404)
    expect((await h.req(url({ kind: 'nope' }))).status).toBe(400)
    expect((await h.req(url({ kind: 'pk', values: { id: 9 } }))).status).toBe(409)
  })

  it('rejects malformed browse parameters', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/databases/shop/tables/users/rows?limit=99999')).status).toBe(400)
    expect((await h.req('/api/databases/shop/tables/users/rows?sort=name:up')).status).toBe(400)
    expect((await h.req('/api/databases/shop/tables/users/rows?filters=nope')).status).toBe(400)
  })

  it('inserts, updates and deletes rows', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const ins = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'POST',
      body: JSON.stringify({ values: { id: 4, name: 'Dave' } }),
    })
    expect(ins.status).toBe(201)
    const upd = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: 4 } }, values: { name: 'David' } }),
    })
    expect(AffectedRowsSchema.parse(await upd.json())).toEqual({ affectedRows: 1 })
    const del = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      body: JSON.stringify({
        keys: [
          { kind: 'pk', values: { id: 4 } },
          { kind: 'pk', values: { id: 3 } },
        ],
      }),
    })
    expect(AffectedRowsSchema.parse(await del.json())).toEqual({ affectedRows: 2 })
    const rows = BrowseResultSchema.parse(await (await h.req('/api/databases/shop/tables/users/rows')).json())
    expect(rows.rows.map((r) => r[1])).toEqual(['Alice', 'Bob'])
  })

  it('returns 409 KEY_MISMATCH when a key matches no row', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: 99 } }, values: { name: 'x' } }),
    })
    expect(res.status).toBe(409)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('KEY_MISMATCH')
  })

  it('rejects invalid row keys and binary cells that are not base64 objects', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'DELETE',
      body: JSON.stringify({ keys: [{ kind: 'magic', values: {} }] }),
    })
    expect(res.status).toBe(400)
    const bad = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'POST',
      body: JSON.stringify({ values: { id: 5, name: { nested: true } } }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('sql & ddl', () => {
  it('executes scripts with defaults applied', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) })
    expect(res.status).toBe(200)
    const results = z.array(StatementResultSchema).parse(await res.json())
    expect(results[0]?.kind).toBe('rows')
    expect(h.adapter.calls.at(-1)?.args).toEqual([
      { database: 'shop' },
      'SELECT 1',
      { maxRows: 1000, timeoutMs: 30_000, stopOnError: true, profile: false },
    ])
  })

  it('streams NDJSON: one result line per statement then done', async () => {
    const adapter = fixtureAdapter({
      onSql: (_ns, sql) =>
        sql
          .split(';')
          .map((s, i) =>
            i === 1
              ? { kind: 'error' as const, sql: s, message: 'boom', code: 'QUERY_FAILED' as const }
              : { kind: 'affected' as const, sql: s, affectedRows: i, durationMs: 1 }
          ),
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql/stream', {
      method: 'POST',
      body: JSON.stringify({ sql: 'A;B;C', stopOnError: false }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => SqlStreamEventSchema.parse(JSON.parse(l)))
    expect(lines.map((l) => l.type)).toEqual(['result', 'result', 'result', 'done'])
    expect(lines[1]).toMatchObject({ type: 'result', index: 1, result: { kind: 'error', message: 'boom' } })
    expect(lines[3]).toEqual({ type: 'done', statements: 3, openTransaction: false })
  })

  it('streams a fatal line when the adapter throws', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    adapter.executeSql = async () => {
      throw new AdapterError('CONNECTION_FAILED', 'gone')
    }
    const res = await h.req('/api/databases/shop/sql/stream', {
      method: 'POST',
      body: JSON.stringify({ sql: 'SELECT 1' }),
    })
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => SqlStreamEventSchema.parse(JSON.parse(l)))
    expect(lines).toEqual([{ type: 'fatal', message: 'gone', code: 'CONNECTION_FAILED' }])
  })

  it('cancels the running script when the stream consumer aborts', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    adapter.executeSql = async (ns, sql, opts) => {
      adapter.calls.push({ method: 'executeSql', args: [ns, sql, opts] })
      const first = { kind: 'affected' as const, sql: 'A', affectedRows: 1, durationMs: 1 }
      await opts.onResult?.(first, 0)
      await gate // simulates a long second statement
      const second = { kind: 'affected' as const, sql: 'B', affectedRows: 1, durationMs: 1 }
      await opts.onResult?.(second, 1)
      return [first, second]
    }
    const queryId = crypto.randomUUID()
    const res = await h.req('/api/databases/shop/sql/stream', {
      method: 'POST',
      body: JSON.stringify({ sql: 'A;B', queryId }),
    })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('"index":0')
    await reader.cancel()
    expect(adapter.calls.at(-1)).toEqual({ method: 'cancelQuery', args: [queryId] })
    release()
    await new Promise((r) => setTimeout(r, 0))
    // Exactly one cancel per abort; a late result after cancel is dropped by the route's `closed` guard.
    expect(adapter.calls.filter((c) => c.method === 'cancelQuery')).toHaveLength(1)
  })

  it('applies backpressure: the next statement result waits until the consumer reads', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const emitted: number[] = []
    adapter.executeSql = async (_ns, _sql, opts) => {
      const r = { kind: 'affected' as const, sql: 'x', affectedRows: 1, durationMs: 1 }
      for (let i = 0; i < 3; i++) {
        await opts.onResult?.(r, i)
        emitted.push(i)
      }
      return [r, r, r]
    }
    const res = await h.req('/api/databases/shop/sql/stream', { method: 'POST', body: JSON.stringify({ sql: 'x' }) })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    await reader.read()
    await new Promise((r) => setTimeout(r, 20))
    // At most the first result (queued) plus one in flight: the rest is gated on our reads.
    expect(emitted.length).toBeLessThanOrEqual(2)
    while (!(await reader.read()).done) {
      // drain
    }
    expect(emitted).toEqual([0, 1, 2])
  })

  it('assigns a queryId to streamed scripts so an abort can always cancel them', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/sql/stream', { method: 'POST', body: JSON.stringify({ sql: 'X' }) })
    await res.text()
    const opts = h.adapter.calls.find((c) => c.method === 'executeSql')?.args[2] as { queryId?: string }
    expect(opts.queryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('passes queryId through and cancels by id', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const queryId = crypto.randomUUID()
    await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', queryId }) })
    expect(h.adapter.calls.at(-1)?.args[2]).toMatchObject({ queryId })
    const miss = await h.req('/api/databases/shop/sql/cancel', { method: 'POST', body: JSON.stringify({ queryId }) })
    expect(SqlCancelResponseSchema.parse(await miss.json())).toEqual({ cancelled: false })
    expect(
      (await h.req('/api/databases/shop/sql/cancel', { method: 'POST', body: JSON.stringify({ queryId: 'nope' }) }))
        .status
    ).toBe(400)
  })

  it('caps maxRows and rejects empty scripts', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(
      (await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: 'x', maxRows: 1e9 }) }))
        .status
    ).toBe(400)
    expect((await h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: '' }) })).status).toBe(
      400
    )
  })

  it('fills copyTable columns, identity and serial columns for the preview (PostgreSQL)', async () => {
    const src = fakeTable('src', ['id', 'n', 'ab', 's'], [])
    for (const c of src.schema.columns) {
      if (c.name === 'id') c.extra = 'identity always'
      if (c.name === 'ab') c.extra = 'STORED GENERATED'
      if (c.name === 's') c.extra = 'serial'
    }
    const h = harness(new FakeAdapter({ dialect: 'postgres', databases: { shop: { tables: { src } } } }))
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'copyTable', table: 'src', newName: 'dst', withData: true } }),
    })
    expect(res.status).toBe(200)
    const sql = DdlPreviewResponseSchema.parse(await res.json()).sql.join('\n')
    expect(sql).toContain('INSERT INTO "public"."dst" ("id", "n", "s") OVERRIDING SYSTEM VALUE SELECT "id", "n", "s"')
    expect(sql).not.toMatch(/INSERT[^\n]*"ab"/)
    expect(sql).toContain('CREATE SEQUENCE "public"."dst_s_seq" OWNED BY "public"."dst"."s"')
    expect(sql).toContain(`pg_get_serial_sequence('"public"."dst"', 'id')`)
    expect(sql).toContain(`pg_get_serial_sequence('"public"."dst"', 's')`)
  })

  it('fills a database rename from the server, whatever table list the request carries', async () => {
    // The route, not only prepareDatabaseOp in isolation: moving that call after build() must fail here.
    const h = harness(
      new FakeAdapter({
        dialect: 'mysql',
        databases: {
          information_schema: { tables: {} },
          shop: { tables: { users: fakeTable('users', ['id'], []), posts: fakeTable('posts', ['id'], []) } },
        },
      })
    )
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/information_schema/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameDatabase', name: 'shop', newName: 'store', tables: ['users'] } }),
    })
    expect(res.status).toBe(200)
    const sql = DdlPreviewResponseSchema.parse(await res.json()).sql.join('\n')
    expect(sql).toContain('`shop`.`users` TO `store`.`users`')
    expect(sql).toContain('`shop`.`posts` TO `store`.`posts`')
    expect(h.adapter.calls.some((c) => c.method === 'executeSql')).toBe(false)
  })

  it('refuses a database rename through the route with a 400 and the reason', async () => {
    const view = fakeTable('active', ['id'], [])
    view.schema.kind = 'view'
    const h = harness(
      new FakeAdapter({
        dialect: 'mysql',
        databases: { information_schema: { tables: {} }, shop: { tables: { active: view } } },
      })
    )
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/information_schema/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameDatabase', name: 'shop', newName: 'store' } }),
    })
    expect(res.status).toBe(400)
    expect(ApiErrorSchema.parse(await res.json())).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('1 views'),
    })
  })

  it('searches one table per request and validates the term', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/tables/users/search?q=ali')
    expect(res.status).toBe(200)
    expect(TableSearchResultSchema.parse(await res.json())).toMatchObject({ total: 1, count: 'exact' })
    expect((await h.req('/api/databases/shop/tables/users/search?q=')).status).toBe(400)
    expect((await h.req(`/api/databases/shop/tables/users/search?q=${'x'.repeat(SEARCH_TERM_MAX + 1)}`)).status).toBe(
      400
    )
    // PostgreSQL cannot hold NUL in text: refused before it reaches the server.
    expect((await h.req('/api/databases/shop/tables/users/search?q=a%00b')).status).toBe(400)
  })

  it('lists the foreign keys of a database for the designer', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/foreign-keys?schema=app')
    expect(res.status).toBe(200)
    RelationDefSchema.array().parse(await res.json())
    expect(h.adapter.calls.at(-1)).toMatchObject({
      method: 'listForeignKeys',
      args: [{ database: 'shop', schema: 'app' }],
    })
  })

  it('builds a query from structured choices and validates them', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const post = (body: unknown) => h.req('/api/databases/shop/query', { method: 'POST', body: JSON.stringify(body) })
    const res = await post({ tables: ['users'], where: [[{ table: 'users', column: 'name', op: 'eq', value: 'a' }]] })
    expect(res.status).toBe(200)
    expect(QueryBuilderResultSchema.parse(await res.json()).sql).toContain('users')
    expect(h.adapter.calls.at(-1)).toMatchObject({
      method: 'buildQuery',
      args: [{ database: 'shop' }, { tables: ['users'], columns: [] }],
    })
    expect((await post({ tables: [] })).status).toBe(400)
    // Only the listed operators: an unknown one is refused before any SQL is written.
    expect(
      (await post({ tables: ['users'], where: [[{ table: 'users', column: 'name', op: 'matches', value: '%' }]] }))
        .status
    ).toBe(400)
    expect((await post({ tables: ['missing'] })).status).toBe(404)
  })

  it('previews DDL without executing it', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'dropColumn', table: 'users', name: 'name' } }),
    })
    expect(res.status).toBe(200)
    expect(DdlPreviewResponseSchema.parse(await res.json())).toEqual({
      sql: ['ALTER TABLE `shop`.`users` DROP COLUMN `name`'],
    })
    expect(h.adapter.calls.some((c) => c.method === 'executeSql')).toBe(false)
  })

  it('rejects unknown DDL ops', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const res = await h.req('/api/databases/shop/ddl/preview', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'renameEverything', table: 'users' } }),
    })
    expect(res.status).toBe(400)
  })
})
