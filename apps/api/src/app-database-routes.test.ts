import { FakeAdapter, fakeColumn, fakeTable } from '@tsmyadmin/adapter/testing'
import { ApiErrorSchema, DdlPreviewResponseSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { closeStoresAfterEach, fixtureAdapter, harness } from './test/app-harness.ts'

const stores = closeStoresAfterEach()

/** The adapter calls a request caused, as `[method, ...args]` (what the fake recorded, minus the log-only noise). */
const called = (adapter: FakeAdapter, method: string) =>
  adapter.calls.filter((c) => c.method === method).map((c) => c.args)

describe('the read routes of a database and its tables', () => {
  // Each is a thin route: the one thing it can get wrong is which adapter method it calls, and with which of the
  // database / schema / table / name from the URL and the query going into which place.
  const ROUTES: [string, string, string, unknown[]][] = [
    [
      'the detail of a routine, with the argument list that picks an overload',
      '/api/databases/shop/routines/calc/detail?kind=function&schema=s1&parameters=a%20integer',
      'routineDetail',
      [{ database: 'shop', schema: 's1' }, 'calc', 'function', 'a integer'],
    ],
    [
      'the detail of a trigger',
      '/api/databases/shop/triggers/tg/detail?table=users&schema=s1',
      'triggerDetail',
      [{ database: 'shop', schema: 's1' }, 'users', 'tg'],
    ],
    [
      'the detail of an event',
      '/api/databases/shop/events/purge/detail?schema=s1',
      'eventDetail',
      [{ database: 'shop', schema: 's1' }, 'purge'],
    ],
    [
      'the partitions of a table',
      '/api/databases/shop/tables/users/partitions?schema=s1',
      'listPartitions',
      [{ database: 'shop', schema: 's1' }, 'users'],
    ],
    [
      'the row count of a table',
      '/api/databases/shop/tables/users/count?schema=s1',
      'countRows',
      [{ database: 'shop', schema: 's1' }, 'users'],
    ],
    [
      'the references to a table',
      '/api/databases/shop/tables/users/references?schema=s1',
      'checkReferences',
      [{ database: 'shop', schema: 's1' }, 'users'],
    ],
    [
      'the distinct values of a column',
      '/api/databases/shop/tables/users/columns/name/distinct?schema=s1',
      'distinctValues',
      [{ database: 'shop', schema: 's1' }, 'users', 'name'],
    ],
  ]

  it.each(ROUTES)('serves %s', async (_name, url, method, expected) => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const res = await h.req(url)
    expect(res.status).toBe(200)
    expect(called(adapter, method)).toEqual([expected])
  })

  it('leaves the schema out when the query has none (MySQL)', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/databases/shop/tables/users/count')).status).toBe(200)
    expect(called(adapter, 'countRows')).toEqual([[{ database: 'shop' }, 'users']])
  })

  it('refuses a routine kind it does not know, before asking the adapter', async () => {
    const adapter = fixtureAdapter()
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    expect((await h.req('/api/databases/shop/routines/calc/detail?kind=trigger')).status).toBe(400)
    expect(called(adapter, 'routineDetail')).toEqual([])
  })
})

describe('the preview of a change to a database, which the server fills in before it builds the SQL', () => {
  const preview = async (h: ReturnType<typeof harness>, op: Record<string, unknown>) => {
    const res = await h.req('/api/databases/shop/ddl/preview', { method: 'POST', body: JSON.stringify({ op }) })
    return {
      res,
      text: res.status === 200 ? DdlPreviewResponseSchema.parse(await res.clone().json()).sql.join('\n') : '',
    }
  }
  const two = (dialect: 'mysql' | 'postgres') =>
    new FakeAdapter({
      dialect,
      databases: {
        shop: {
          tables: {
            users: fakeTable('users', ['id', 'name'], []),
            posts: fakeTable('posts', ['id', 'title'], []),
          },
        },
      },
    })

  it('refuses a name longer than the dialect allows, naming it, instead of letting PostgreSQL cut it', async () => {
    const h = harness(two('mysql'))
    stores.push(h.store)
    await h.login()
    const { res } = await preview(h, { op: 'renameTable', table: 'users', newName: 'x'.repeat(70) })
    expect(res.status).toBe(400)
    const body = ApiErrorSchema.parse(await res.json())
    expect(body.code).toBe('VALIDATION')
    expect(body).toMatchObject({ reason: 'IDENTIFIER_TOO_LONG', params: { max: 64 } })
  })

  it('lists every table of the database for a collation that is applied to them, whatever the request carried', async () => {
    const h = harness(two('mysql'))
    stores.push(h.store)
    await h.login()
    const { res, text } = await preview(h, {
      op: 'setDatabaseCollation',
      name: 'shop',
      collation: 'utf8mb4_unicode_ci',
      applyToTables: true,
    })
    expect(res.status).toBe(200)
    expect(text).toContain('`users`')
    expect(text).toContain('`posts`')
  })

  it('lists the text columns of each table, and only those, for a collation change on PostgreSQL', async () => {
    const posts = fakeTable('posts', ['id', 'title'], [])
    posts.schema.columns = [fakeColumn('id', 'integer'), fakeColumn('title', 'character varying')]
    const h = harness(new FakeAdapter({ dialect: 'postgres', databases: { shop: { tables: { posts } } } }))
    stores.push(h.store)
    await h.login()
    const { res, text } = await preview(h, {
      op: 'setDatabaseCollation',
      name: 'shop',
      collation: 'C',
      applyToTables: true,
    })
    expect(res.status).toBe(200)
    expect(text).toContain('"title"')
    expect(text).not.toMatch(/ALTER TABLE[^\n]*"id"[^\n]*COLLATE/)
  })

  it('fills in what a copy of several tables needs, per table: the columns it can write, a generated one left out', async () => {
    const users = fakeTable('users', ['id', 'name', 'ab'], [])
    for (const c of users.schema.columns) if (c.name === 'ab') c.extra = 'STORED GENERATED'
    const adapter = new FakeAdapter({
      dialect: 'mysql',
      databases: { shop: { tables: { users, posts: fakeTable('posts', ['id', 'title'], []) } } },
    })
    const h = harness(adapter)
    stores.push(h.store)
    await h.login()
    const { res, text } = await preview(h, {
      op: 'copyTables',
      tables: ['users', 'posts'],
      toDatabase: 'other',
      withData: true,
    })
    expect(res.status).toBe(200)
    // The request carried no column list: the server read each table, and the statements say which columns.
    expect(
      called(adapter, 'describeTable')
        .map((a) => a[1])
        .sort()
    ).toEqual(['posts', 'users'])
    expect(text).toMatch(/INSERT INTO `other`\.`users` \(`id`, `name`\)/)
    expect(text).toMatch(/INSERT INTO `other`\.`posts` \(`id`, `title`\)/)
    expect(text).not.toMatch(/INSERT[^\n]*`ab`/)
  })

  it('leaves a generated column out of a copy of one table with its data (MySQL)', async () => {
    const t = fakeTable('src', ['id', 'n', 'ab'], [])
    for (const c of t.schema.columns) if (c.name === 'ab') c.extra = 'STORED GENERATED'
    const h = harness(new FakeAdapter({ dialect: 'mysql', databases: { shop: { tables: { src: t } } } }))
    stores.push(h.store)
    await h.login()
    const { res, text } = await preview(h, { op: 'copyTable', table: 'src', newName: 'dst', withData: true })
    expect(res.status).toBe(200)
    expect(text).toMatch(/INSERT INTO `shop`\.`dst` \(`id`, `n`\)/)
    expect(text).not.toMatch(/INSERT[^\n]*`ab`/)
  })
})
