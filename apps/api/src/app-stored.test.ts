import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import {
  ApiErrorSchema,
  CentralColumnSchema,
  ColumnTransformSchema,
  ConnectRequestSchema,
  DesignerPageSchema,
  ExportTemplateSchema,
  QueryTemplateSchema,
  SAVED_QUERY_MAX_SQL,
  SavedQuerySchema,
  SessionStateSchema,
  TRACKING_DEFINITION_MAX,
  TrackingStateSchema,
  UserGroupSchema,
} from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { SAVED_QUERY_LIMIT } from './session/saved-queries.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { closeStoresAfterEach, fixtureAdapter, harness, LOGIN, testConfig } from './test-support/app-harness.ts'

const stores = closeStoresAfterEach()

describe('saved queries', () => {
  /** Same harness, but on the persistent store — the only one that can keep bookmarks. */
  function persistentHarness() {
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => fixtureAdapter(),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (body: Record<string, unknown> = LOGIN) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
      return res
    }
    const save = (name: string, sql: string) =>
      req('/api/saved-queries', { method: 'POST', body: JSON.stringify({ name, sql }) })
    return { store, req, login, save }
  }

  it('tells the client the list lives on the server and round-trips it', async () => {
    const h = persistentHarness()
    try {
      const state = SessionStateSchema.parse(await (await h.login()).json())
      expect(state.savedQueries).toBe('server')

      const saved = z.array(SavedQuerySchema).parse(await (await h.save('daily', 'SELECT 1')).json())
      expect(saved).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }])
      expect(await (await h.req('/api/saved-queries')).json()).toEqual(saved)

      const left = await (await h.req(`/api/saved-queries/${saved[0]?.id}`, { method: 'DELETE' })).json()
      expect(left).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps one account out of another account’s list', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const mine = z.array(SavedQuerySchema).parse(await (await h.save('mine', 'SELECT 1')).json())
      // A second login as a different user gets a session of its own, and sees none of it.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/saved-queries')).json()).toEqual([])
      // Nor can it delete a row it cannot see.
      expect(await (await h.req(`/api/saved-queries/${mine[0]?.id}`, { method: 'DELETE' })).json()).toEqual([])
      await h.login()
      expect(await (await h.req('/api/saved-queries')).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('needs a session, and rejects an empty name or statement', async () => {
    const h = persistentHarness()
    try {
      expect((await h.save('daily', 'SELECT 1')).status).toBe(401)
      await h.login()
      expect((await h.save('', 'SELECT 1')).status).toBe(400)
      expect((await h.save('daily', '')).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('caps the statement length, because this list is kept on disk', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      expect((await h.save('long', 'x'.repeat(SAVED_QUERY_MAX_SQL))).status).toBe(200)
      // Without a cap, the 200-row allowance alone would let one account write 200 MB into the session file.
      expect((await h.save('longer', 'x'.repeat(SAVED_QUERY_MAX_SQL + 1))).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps query-builder setups per database and name, and refuses one the builder would refuse', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const setup = (database: string, tables: string[]) => ({
        name: 'mine',
        database,
        request: { tables, columns: [], where: [] },
      })
      const post = (body: unknown) => h.req('/api/query-templates', { method: 'POST', body: JSON.stringify(body) })
      await post(setup('shop', ['users']))
      // The same name in another database is another setup; in the same one it replaces.
      await post(setup('other', ['t']))
      const saved = z.array(QueryTemplateSchema).parse(await (await post(setup('shop', ['users', 'posts']))).json())
      expect(saved.map((x) => [x.database, x.request.tables])).toEqual(
        expect.arrayContaining([
          ['shop', ['users', 'posts']],
          ['other', ['t']],
        ])
      )
      expect(saved).toHaveLength(2)
      expect((await post(setup('shop', []))).status).toBe(400)
      const id = saved.find((x) => x.database === 'other')?.id ?? ''
      expect(await (await h.req(`/api/query-templates/${id}`, { method: 'DELETE' })).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps Designer pages per database and name, and refuses positions that are not numbers', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const page = (database: string, x: number) => ({ name: 'overview', database, positions: { users: { x, y: 0 } } })
      const post = (body: unknown) => h.req('/api/designer-pages', { method: 'POST', body: JSON.stringify(body) })
      await post(page('shop', 1))
      await post(page('other', 2))
      const saved = z.array(DesignerPageSchema).parse(await (await post(page('shop', 3))).json())
      expect(saved.map((x) => [x.database, x.positions.users?.x, x.allColumns])).toEqual(
        expect.arrayContaining([
          ['shop', 3, false],
          ['other', 2, false],
        ])
      )
      expect(saved).toHaveLength(2)
      expect((await post({ ...page('shop', 1), positions: { users: { x: 'left', y: 0 } } })).status).toBe(400)
      const id = saved.find((x) => x.database === 'other')?.id ?? ''
      expect(await (await h.req(`/api/designer-pages/${id}`, { method: 'DELETE' })).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps export templates as their own list beside the bookmarks', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const body = {
        name: 'nightly',
        database: 'shop',
        tables: ['users'],
        options: {
          format: 'csv',
          structure: false,
          data: true,
          dropTable: true,
          bom: true,
          csvSafe: true,
          routines: false,
          stripDefiner: false,
        },
      }
      const saved = z
        .array(ExportTemplateSchema)
        .parse(await (await h.req('/api/export-templates', { method: 'POST', body: JSON.stringify(body) })).json())
      expect(saved).toMatchObject([{ name: 'nightly', database: 'shop', tables: ['users'] }])
      expect(saved[0]?.options.format).toBe('csv')
      // The same name in the other list is a different item, and neither list shows the other's.
      await h.save('nightly', 'SELECT 1')
      expect(await (await h.req('/api/export-templates')).json()).toHaveLength(1)
      expect(z.array(SavedQuerySchema).parse(await (await h.req('/api/saved-queries')).json())).toMatchObject([
        { name: 'nightly', sql: 'SELECT 1' },
      ])
      // The same name in another database is a second template, not a replacement of the first.
      const both = z.array(ExportTemplateSchema).parse(
        await (
          await h.req('/api/export-templates', {
            method: 'POST',
            body: JSON.stringify({ ...body, database: 'blog' }),
          })
        ).json()
      )
      expect(both.map((x) => x.database).sort()).toEqual(['blog', 'shop'])
      // Deleting by an id of the other kind removes nothing.
      const bookmarks = z.array(SavedQuerySchema).parse(await (await h.req('/api/saved-queries')).json())
      expect(
        await (await h.req(`/api/export-templates/${bookmarks[0]?.id}`, { method: 'DELETE' })).json()
      ).toHaveLength(2)
      expect(await (await h.req('/api/saved-queries')).json()).toHaveLength(1)
      await h.req(`/api/export-templates/${both.find((x) => x.database === 'blog')?.id}`, { method: 'DELETE' })

      // A template of another database is refused before it is stored; deleting is by id, as bookmarks are.
      expect(
        (await h.req('/api/export-templates', { method: 'POST', body: JSON.stringify({ ...body, database: '' }) }))
          .status
      ).toBe(400)
      expect(await (await h.req(`/api/export-templates/${saved[0]?.id}`, { method: 'DELETE' })).json()).toEqual([])
      expect(await (await h.req('/api/saved-queries')).json()).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('reads a template row written before the name was kept in its payload, and leaves it alone', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const config = ConnectRequestSchema.parse(LOGIN)
      // Older than the legacy row below, so an eviction would take one of these rather than the row being replaced.
      for (let i = 0; i < SAVED_QUERY_LIMIT - 1; i++) {
        await h.store.savedQueries.save(config, 'sql', `fill-${i}`, 'SELECT 1')
      }
      // The shape 0.3.0-dev wrote: the name was the row's key, the body held only the choices. The account is now
      // exactly at its cap, so replacing this row must not make room for itself by evicting anything.
      const body = { database: 'shop', tables: ['users'], options: { format: 'sql' } }
      await h.store.savedQueries.save(config, 'export', 'nightly', JSON.stringify(body))
      const listed = z.array(ExportTemplateSchema).parse(await (await h.req('/api/export-templates')).json())
      expect(listed).toMatchObject([{ name: 'nightly', database: 'shop', tables: ['users'] }])
      expect(await h.store.savedQueries.list(config, 'sql')).toHaveLength(SAVED_QUERY_LIMIT - 1)

      // A save that fails puts the row it was replacing back, rather than leaving the account with neither.
      const real = h.store.savedQueries.save.bind(h.store.savedQueries)
      let broken = true
      h.store.savedQueries.save = async (...args: Parameters<typeof real>) => {
        // The write of the new row fails; putting the old one back must still work, as it would on a real store.
        if (args[1] === 'export' && broken) {
          broken = false
          throw new Error('disk full')
        }
        return real(...args)
      }
      const failed = await h.req('/api/export-templates', {
        method: 'POST',
        body: JSON.stringify({ name: 'nightly', database: 'shop', tables: ['posts'], options: {} }),
      })
      expect(failed.status).toBe(500)
      h.store.savedQueries.save = real
      expect(z.array(ExportTemplateSchema).parse(await (await h.req('/api/export-templates')).json())).toMatchObject([
        { name: 'nightly', tables: ['users'] },
      ])

      // Saving that name again replaces it rather than leaving two rows showing the same name.
      const after = z.array(ExportTemplateSchema).parse(
        await (
          await h.req('/api/export-templates', {
            method: 'POST',
            body: JSON.stringify({ name: 'nightly', database: 'shop', tables: ['posts'], options: {} }),
          })
        ).json()
      )
      expect(after).toMatchObject([{ name: 'nightly', tables: ['posts'] }])
      expect(await (await h.req('/api/export-templates')).json()).toHaveLength(1)
      // The bookmarks that filled the account are all still there.
      expect(await h.store.savedQueries.list(config, 'sql')).toHaveLength(SAVED_QUERY_LIMIT - 1)
      await h.req(`/api/export-templates/${after[0]?.id}`, { method: 'DELETE' })

      // Reading it did not delete it: a row this version cannot fully interpret is not data to throw away.
      // The legacy row was read as a template before it was replaced, rather than being thrown away on sight.
      expect(listed[0]?.tables).toEqual(['users'])
    } finally {
      await h.store.closeAll()
    }
  })

  it('reports the browser mode, and refuses to save, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    const state = SessionStateSchema.parse(await (await h.login()).json())
    expect(state.savedQueries).toBe('browser')
    expect(await (await h.req('/api/saved-queries')).json()).toEqual([])
    const res = await h.req('/api/saved-queries', {
      method: 'POST',
      body: JSON.stringify({ name: 'daily', sql: 'SELECT 1' }),
    })
    expect(res.status).toBe(400)
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('UNSUPPORTED')
    expect(await (await h.req('/api/export-templates')).json()).toEqual([])
    const template = await h.req('/api/export-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'nightly', database: 'shop', options: {} }),
    })
    expect(template.status).toBe(400)
    expect(ApiErrorSchema.parse(await template.json()).code).toBe('UNSUPPORTED')
  })
})

describe('preferences, central columns and column transformations', () => {
  function persistentHarness() {
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => fixtureAdapter(),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (body: Record<string, unknown> = LOGIN) => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify(body) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
      return res
    }
    const send = (path: string, method: string, body: unknown) => req(path, { method, body: JSON.stringify(body) })
    return { store, req, login, send }
  }

  it('keeps preferences with the account, and only the known fields', async () => {
    const h = persistentHarness()
    try {
      expect((await h.send('/api/preferences', 'PUT', { theme: 'dark' })).status).toBe(401)
      await h.login()
      expect(await (await h.req('/api/preferences')).json()).toEqual({})
      const put = await h.send('/api/preferences', 'PUT', { theme: 'dark', browseLimit: 25, extra: 'dropped' })
      expect(await put.json()).toEqual({ theme: 'dark', browseLimit: 25 })
      expect(await (await h.req('/api/preferences')).json()).toEqual({ theme: 'dark', browseLimit: 25 })
      expect((await h.send('/api/preferences', 'PUT', { browseLimit: 0 })).status).toBe(400)
      // Merged, not replaced: a second tab sending only what it changed keeps what the first one set.
      await h.send('/api/preferences', 'PUT', { consoleDocked: true })
      expect(await (await h.req('/api/preferences')).json()).toEqual({
        theme: 'dark',
        browseLimit: 25,
        consoleDocked: true,
      })
      // The settings screen's fields are kept too, and a `null` takes one away again.
      const settings = {
        sqlHistoryMax: 250,
        navGroupDelimiter: '_',
        navHidden: ['scratch'],
        exportDefaults: { format: 'json' },
      }
      await h.send('/api/preferences', 'PUT', settings)
      const kept = (await (await h.req('/api/preferences')).json()) as Record<string, unknown>
      expect(kept).toMatchObject({ sqlHistoryMax: 250, navGroupDelimiter: '_', navHidden: ['scratch'] })
      expect((kept.exportDefaults as { format: string }).format).toBe('json')
      expect((await h.send('/api/preferences', 'PUT', { navPageSize: 5000 })).status).toBe(400)
      await h.send('/api/preferences', 'PUT', { sqlHistoryMax: null, exportDefaults: null, browseLimit: null })
      const left = (await (await h.req('/api/preferences')).json()) as Record<string, unknown>
      expect(Object.keys(left).sort()).toEqual(['consoleDocked', 'navGroupDelimiter', 'navHidden', 'theme'])
      // Another account has its own.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/preferences')).json()).toEqual({})
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps the favourite tables and the like with the account, merged and limited to known keys', async () => {
    const h = persistentHarness()
    try {
      expect((await h.send('/api/workspace', 'PUT', { set: { 'sidebar.collapsed': true } })).status).toBe(401)
      await h.login()
      expect(await (await h.req('/api/workspace')).json()).toEqual({ entries: {} })
      const favourites = [{ db: 'shop', table: 'orders' }]
      const put = await h.send('/api/workspace', 'PUT', {
        set: { 'tables.favorites.mysql|h|3306|u': favourites, 'sidebar.collapsed': true },
      })
      expect(await put.json()).toEqual({
        entries: { 'tables.favorites.mysql|h|3306|u': favourites, 'sidebar.collapsed': true },
      })
      // Merged: a second browser sending only what it changed keeps the rest; `remove` takes one away.
      await h.send('/api/workspace', 'PUT', { set: { 'display-column.["shop","","orders"]': 'name' } })
      await h.send('/api/workspace', 'PUT', { remove: ['sidebar.collapsed'] })
      const kept = (await (await h.req('/api/workspace')).json()) as { entries: Record<string, unknown> }
      expect(Object.keys(kept.entries).sort()).toEqual([
        'display-column.["shop","","orders"]',
        'tables.favorites.mysql|h|3306|u',
      ])
      // Only the keys the account is meant to keep, and values of a sane size.
      expect((await h.send('/api/workspace', 'PUT', { set: { 'sql.safeMode': false } })).status).toBe(400)
      expect((await h.send('/api/workspace', 'PUT', { set: { 'browse.cols.x': 'a'.repeat(9000) } })).status).toBe(400)
      // Another account has its own.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/workspace')).json()).toEqual({ entries: {} })
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps central columns per database, replacing one by name', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const column = { database: 'shop', name: 'created_at', dataType: 'datetime', nullable: false, default: null }
      await h.send('/api/central-columns', 'POST', column)
      await h.send('/api/central-columns', 'POST', { ...column, database: 'blog' })
      const replaced = z
        .array(CentralColumnSchema)
        .parse(await (await h.send('/api/central-columns', 'POST', { ...column, dataType: 'timestamp' })).json())
      expect(replaced.map((c) => [c.database, c.dataType]).sort()).toEqual([
        ['blog', 'datetime'],
        ['shop', 'timestamp'],
      ])
      const shop = replaced.find((c) => c.database === 'shop')
      // Another account can neither see nor delete it by id.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req(`/api/central-columns/${shop?.id}`, { method: 'DELETE' })).json()).toEqual([])
      await h.login()
      const left = await (await h.req(`/api/central-columns/${shop?.id}`, { method: 'DELETE' })).json()
      expect(left).toMatchObject([{ database: 'blog' }])
      expect((await h.send('/api/central-columns', 'POST', { ...column, name: '' })).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps one transformation per column, and refuses a link template that is not http(s)', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const target = { database: 'shop', table: 'items', column: 'url' }
      await h.send('/api/column-transforms', 'POST', { ...target, kind: 'link' })
      const set = z
        .array(ColumnTransformSchema)
        .parse(
          await (
            await h.send('/api/column-transforms', 'POST', { ...target, kind: 'link', template: 'https://x/{value}' })
          ).json()
        )
      expect(set).toMatchObject([{ kind: 'link', template: 'https://x/{value}' }])
      const refused = await h.send('/api/column-transforms', 'POST', {
        ...target,
        kind: 'link',
        template: 'javascript:alert({value})',
      })
      expect(refused.status).toBe(400)
      expect((await h.send('/api/column-transforms', 'POST', { ...target, kind: 'script' })).status).toBe(400)
      expect(await (await h.req(`/api/column-transforms/${set[0]?.id}`, { method: 'DELETE' })).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps the display and the input transformation of a column apart, and refuses options a kind cannot use', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const target = { database: 'shop', table: 'items', column: 'zip' }
      const post = (body: Record<string, unknown>) => h.send('/api/column-transforms', 'POST', { ...target, ...body })
      await post({ kind: 'substring', start: 0, length: 3 })
      const both = z
        .array(ColumnTransformSchema)
        .parse(await (await post({ kind: 'pattern', pattern: '^\\d+$' })).json())
      expect(both.map((t) => t.kind).sort()).toEqual(['pattern', 'substring'])
      // Setting the display one again replaces it, not the input one.
      const again = z.array(ColumnTransformSchema).parse(await (await post({ kind: 'hex' })).json())
      expect(again.map((t) => t.kind).sort()).toEqual(['hex', 'pattern'])
      for (const bad of [
        { kind: 'substring' },
        { kind: 'date' },
        { kind: 'affix' },
        { kind: 'pattern' },
        { kind: 'pattern', pattern: '(' },
        { kind: 'hex', template: 'https://x/{value}' },
        { kind: 'substring', length: 0 },
        { kind: 'date', format: 'x'.repeat(61) },
      ])
        expect((await post(bad)).status).toBe(400)
      expect((await post({ kind: 'json-input' })).status).toBe(200)
    } finally {
      await h.store.closeAll()
    }
  })

  it('shares bookmarks with the whole server, removable only by whoever saved them', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      expect(await (await h.req('/api/shared-queries')).json()).toEqual([])
      const saved = (await (
        await h.send('/api/shared-queries', 'POST', { name: 'daily', sql: 'SELECT 1' })
      ).json()) as {
        id: string
        by: string
      }[]
      expect(saved).toMatchObject([{ name: 'daily', sql: 'SELECT 1', by: LOGIN.user }])
      // Another account sees it, cannot write over the name, and cannot remove it.
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/shared-queries')).json()).toMatchObject([{ name: 'daily' }])
      expect((await h.send('/api/shared-queries', 'POST', { name: 'daily', sql: 'DROP' })).status).toBe(409)
      const refused = await h.req(`/api/shared-queries/${saved[0]?.id}`, { method: 'DELETE' })
      expect(refused.status).toBe(403)
      expect(await (await h.req('/api/shared-queries')).json()).toMatchObject([{ sql: 'SELECT 1' }])
      // Its owner can replace and remove it.
      await h.login()
      await h.send('/api/shared-queries', 'POST', { name: 'daily', sql: 'SELECT 2' })
      expect(await (await h.req('/api/shared-queries')).json()).toMatchObject([{ sql: 'SELECT 2' }])
      const id = ((await (await h.req('/api/shared-queries')).json()) as { id: string }[])[0]?.id
      expect(await (await h.req(`/api/shared-queries/${id}`, { method: 'DELETE' })).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('does not lose a run when two are added at once, nor let two accounts take one shared name', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      const add = (sql: string) => h.send('/api/sql-history', 'POST', { entry: { sql, at: 1, ok: true }, limit: 100 })
      await Promise.all(['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4'].map(add))
      const kept = (await (await h.req('/api/sql-history')).json()) as { entries: { sql: string }[] }
      expect(kept.entries.map((e) => e.sql).sort()).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4'])
      // Saved at once under one name by the same account: one bookmark, and never a second owner.
      await Promise.all(['a', 'b', 'c'].map((sql) => h.send('/api/shared-queries', 'POST', { name: 'same', sql })))
      const list = (await (await h.req('/api/shared-queries')).json()) as { name: string; by: string }[]
      expect(list.filter((q) => q.name === 'same')).toHaveLength(1)
    } finally {
      await h.store.closeAll()
    }
  })

  it('keeps the SQL history with the account: added to, deduplicated and cut to the limit asked', async () => {
    const h = persistentHarness()
    try {
      await h.login()
      expect(await (await h.req('/api/sql-history')).json()).toEqual({ entries: [] })
      const add = async (sql: string, limit = 3) =>
        (await (
          await h.send('/api/sql-history', 'POST', { entry: { sql, at: 1, ok: true, db: 'shop' }, limit })
        ).json()) as {
          entries: { sql: string }[]
        }
      await add('SELECT 1')
      await add('SELECT 2')
      expect((await add('SELECT 1')).entries.map((e) => e.sql)).toEqual(['SELECT 1', 'SELECT 2'])
      await add('SELECT 3')
      expect((await add('SELECT 4')).entries.map((e) => e.sql)).toEqual(['SELECT 4', 'SELECT 3', 'SELECT 1'])
      expect(await (await h.req('/api/sql-history')).json()).toMatchObject({ entries: [{ sql: 'SELECT 4' }, {}, {}] })
      // A statement or a limit past the bounds is refused; clearing empties it; another account has its own.
      expect((await add('x'.repeat(10_001))).entries).toBeUndefined()
      const refusedLimit = await h.send('/api/sql-history', 'POST', {
        entry: { sql: 'a', at: 1, ok: true },
        limit: 1001,
      })
      expect(refusedLimit.status).toBe(400)
      await h.login({ ...LOGIN, user: 'reader' })
      expect(await (await h.req('/api/sql-history')).json()).toEqual({ entries: [] })
      await h.login()
      expect(await (await h.req('/api/sql-history', { method: 'DELETE' })).json()).toEqual({ entries: [] })
      expect(await (await h.req('/api/sql-history')).json()).toEqual({ entries: [] })
    } finally {
      await h.store.closeAll()
    }
  })

  it('reads as empty, and refuses to write, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/preferences')).json()).toEqual({})
    expect(await (await h.req('/api/workspace')).json()).toEqual({ entries: {} })
    expect((await h.req('/api/workspace', { method: 'PUT', body: JSON.stringify({ remove: [] }) })).status).toBe(400)
    expect(await (await h.req('/api/central-columns')).json()).toEqual([])
    expect(await (await h.req('/api/shared-queries')).json()).toEqual([])
    expect(await (await h.req('/api/sql-history')).json()).toEqual({ entries: [] })
    const shareRes = await h.req('/api/shared-queries', {
      method: 'POST',
      body: JSON.stringify({ name: 'a', sql: 'SELECT 1' }),
    })
    expect(shareRes.status).toBe(400)
    const put = await h.req('/api/preferences', { method: 'PUT', body: JSON.stringify({ theme: 'dark' }) })
    expect(put.status).toBe(400)
    expect(await put.json()).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('user groups', () => {
  function sharedHarness() {
    let manage = true
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => fixtureAdapter({ manageAccounts: manage }),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    /** Signs in as `user`; `canManage` decides what the new session's canManageAccount answers. */
    const login = async (user: string, canManage = true) => {
      manage = canManage
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify({ ...LOGIN, user }) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
      return res
    }
    const save = (body: unknown) => req('/api/user-groups', { method: 'POST', body: JSON.stringify(body) })
    return { store, req, login, save }
  }

  it('hides what a group says from its members, and only from them', async () => {
    const h = sharedHarness()
    try {
      await h.login('root')
      const saved = await h.save({ name: 'readers', members: ['alice'], hiddenTabs: ['server:sql', 'db:export'] })
      expect(z.array(UserGroupSchema).parse(await saved.json())).toMatchObject([{ name: 'readers' }])
      await h.login('alice', false)
      expect(await (await h.req('/api/user-groups/mine')).json()).toEqual({ hiddenTabs: ['db:export', 'server:sql'] })
      // A member who cannot manage the others does not see the group itself (it names accounts).
      expect(await (await h.req('/api/user-groups')).json()).toEqual([])
      await h.login('bob', false)
      expect(await (await h.req('/api/user-groups/mine')).json()).toEqual({ hiddenTabs: [] })
    } finally {
      await h.store.closeAll()
    }
  })

  it('lets only an account that can manage the members change or delete a group', async () => {
    const h = sharedHarness()
    try {
      await h.login('root')
      const [group] = z
        .array(UserGroupSchema)
        .parse(await (await h.save({ name: 'readers', members: ['alice'], hiddenTabs: [] })).json())
      await h.login('alice', false)
      // Neither by replacing it under the same name nor by deleting it: alice could lift her own restriction.
      expect((await h.save({ name: 'readers', members: ['alice'], hiddenTabs: [] })).status).toBe(403)
      expect((await h.req(`/api/user-groups/${group?.id}`, { method: 'DELETE' })).status).toBe(403)
      await h.login('root')
      expect(await (await h.req(`/api/user-groups/${group?.id}`, { method: 'DELETE' })).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('refuses an unknown tab, and a group without members', async () => {
    const h = sharedHarness()
    try {
      await h.login('root')
      expect((await h.save({ name: 'x', members: ['a'], hiddenTabs: ['server:security'] })).status).toBe(400)
      expect((await h.save({ name: 'x', members: [], hiddenTabs: [] })).status).toBe(400)
    } finally {
      await h.store.closeAll()
    }
  })

  it('has nothing to hide, and refuses to save, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/user-groups/mine')).json()).toEqual({ hiddenTabs: [] })
    const res = await h.req('/api/user-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', members: ['a'], hiddenTabs: [] }),
    })
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('change tracking', () => {
  function trackingHarness() {
    // One set of tables behind every session, so a change to it is seen by all of them.
    const users = fakeTable('users', ['id', 'name'], [{ id: 1, name: 'Alice' }])
    users.definition = 'CREATE TABLE users (\n  id int,\n  name text\n)'
    const tables = { users }
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's'.repeat(32),
      adapterFactory: () => new FakeAdapter({ databases: { shop: { tables } } }),
      sweepIntervalMs: 0,
    })
    const app = createApp(testConfig(), { store })
    let cookie = ''
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      })
    const login = async (user = 'root') => {
      const res = await req('/api/session', { method: 'POST', body: JSON.stringify({ ...LOGIN, user }) })
      cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    }
    const state = async (method = 'GET', table = 'users') =>
      req(`/api/databases/shop/tables/${table}/tracking`, { method })
    return { store, users, login, state, req }
  }

  it('reads the session once although the databases and tracking guards both match the path', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      const get = vi.spyOn(h.store, 'get')
      expect((await h.req('/api/databases/shop/tracking')).status).toBe(200)
      expect((await h.state()).status).toBe(200)
      expect(get).toHaveBeenCalledTimes(2)
    } finally {
      await h.store.closeAll()
    }
  })

  it('records versions only when the definition changed, shared by every account of the server', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      expect(TrackingStateSchema.parse(await (await h.state()).json()).versions).toEqual([])
      const first = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(first.versions).toMatchObject([{ version: 1, by: 'root', table: 'users' }])
      // Nothing changed: no second version.
      expect(TrackingStateSchema.parse(await (await h.state('POST')).json()).versions).toHaveLength(1)
      h.users.definition = 'CREATE TABLE users (\n  id int,\n  name varchar(20)\n)'
      // Another account records the next one, and sees the first.
      await h.login('reader')
      const second = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(second.versions.map((v) => [v.version, v.by])).toEqual([
        [1, 'root'],
        [2, 'reader'],
      ])
      expect(second.versions[1]?.definition).toContain('varchar(20)')
      expect(TrackingStateSchema.parse(await (await h.state('DELETE')).json()).versions).toEqual([])
      expect(TrackingStateSchema.parse(await (await h.state()).json()).versions).toEqual([])
      // A definition too long to keep is refused rather than stored.
      h.users.definition = 'x'.repeat(TRACKING_DEFINITION_MAX + 1)
      expect(await (await h.state('POST')).json()).toMatchObject({ code: 'UNSUPPORTED' })
      expect(TrackingStateSchema.parse(await (await h.state()).json()).versions).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('records the statement kinds chosen for a tracked table, and grid edits without their values', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      const sql = (text: string) =>
        h.req('/api/databases/shop/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
      const kinds = (list: string[]) =>
        h.req('/api/databases/shop/tables/users/tracking/kinds', {
          method: 'PUT',
          body: JSON.stringify({ kinds: list }),
        })
      // Not tracked yet: nothing is recorded, and kinds cannot be set.
      await sql('ALTER TABLE users ADD COLUMN a INT')
      expect((await kinds(['alter'])).status).toBe(400)
      // Tracking starts with the definition changes.
      const started = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(started.kinds).toEqual(['create', 'alter', 'rename', 'drop', 'truncate', 'index'])
      await sql('ALTER TABLE `shop`.`users` ADD COLUMN b INT')
      await sql("UPDATE users SET name = 'x'")
      await sql('ALTER TABLE posts ADD COLUMN c INT')
      let log = TrackingStateSchema.parse(await (await h.state()).json()).log ?? []
      expect(log.map((e) => [e.kind, e.statement])).toEqual([['alter', 'ALTER TABLE `shop`.`users` ADD COLUMN b INT']])
      // Row changes, once asked for: the statement from the console, and a grid edit as what it touched.
      await kinds(['alter', 'update'])
      await sql("UPDATE users SET name = 'y'")
      await h.req('/api/databases/shop/tables/users/rows', {
        method: 'PATCH',
        body: JSON.stringify({ key: { kind: 'pk', values: { id: 1 } }, values: { name: 'secret value' } }),
      })
      log = TrackingStateSchema.parse(await (await h.state()).json()).log ?? []
      expect(log.slice(0, 2).map((e) => [e.kind, e.statement, e.columns ?? null])).toEqual([
        ['update', null, ['name']],
        ['update', "UPDATE users SET name = 'y'", null],
      ])
      expect(JSON.stringify(log)).not.toContain('secret value')
      // The database's list of tracked tables.
      const list = await (await h.req('/api/databases/shop/tracking')).json()
      expect(list).toMatchObject([{ table: 'users', versions: 1, latest: 1, kinds: ['alter', 'update'] }])
      // Stopping forgets the settings and the log with the versions.
      await h.state('DELETE')
      expect(await (await h.req('/api/databases/shop/tracking')).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('forgets one version of a tracked table, and the last one is the same as stopping', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      await h.state('POST')
      h.users.definition = 'CREATE TABLE users (\n  id int,\n  name varchar(20)\n)'
      const two = TrackingStateSchema.parse(await (await h.state('POST')).json())
      expect(two.versions.map((v) => v.version)).toEqual([1, 2])
      const del = (v: number) => h.req(`/api/databases/shop/tables/users/tracking/${v}`, { method: 'DELETE' })
      expect((await del(9)).status).toBe(404)
      const one = TrackingStateSchema.parse(await (await del(1)).json())
      expect(one.versions.map((v) => v.version)).toEqual([2])
      const none = TrackingStateSchema.parse(await (await del(2)).json())
      expect(none.versions).toEqual([])
      expect(await (await h.req('/api/databases/shop/tracking')).json()).toEqual([])
    } finally {
      await h.store.closeAll()
    }
  })

  it('reveals nothing about a table the account cannot read', async () => {
    const h = trackingHarness()
    try {
      await h.login()
      await h.state('POST')
      // The definition is read through the caller's session first: a table it cannot see answers as missing.
      const missing = await h.state('GET', 'secret')
      expect(missing.status).toBe(404)
      expect(await missing.json()).not.toHaveProperty('versions')
    } finally {
      await h.store.closeAll()
    }
  })

  it('reads, and refuses to record, without a persistent store', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect(await (await h.req('/api/databases/shop/tables/users/tracking')).json()).toMatchObject({ versions: [] })
    const res = await h.req('/api/databases/shop/tables/users/tracking', { method: 'POST' })
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('row functions', () => {
  it('writes through an allowed function and refuses anything else', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const post = (values: unknown) =>
      h.req('/api/databases/shop/tables/users/rows', { method: 'POST', body: JSON.stringify({ values }) })
    expect((await post({ id: 9, name: { $fn: 'upper', arg: 'zed' } })).status).toBe(201)
    // Only the listed functions, and never raw SQL in their place.
    expect((await post({ id: 10, name: { $fn: 'sleep', arg: 5 } })).status).toBe(400)
    expect((await post({ id: 10, name: { $fn: 'upper', arg: 'x', sql: 'DROP' } })).status).toBe(400)
    // A key identifies a row: it is matched, never computed.
    const patch = await h.req('/api/databases/shop/tables/users/rows', {
      method: 'PATCH',
      body: JSON.stringify({ key: { kind: 'pk', values: { id: { $fn: 'now' } } }, values: { name: 'x' } }),
    })
    expect(patch.status).toBe(400)
  })
})
