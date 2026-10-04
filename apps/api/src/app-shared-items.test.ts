import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { TRACKING_DEFINITION_MAX, TrackingStateSchema, UserGroupSchema } from '@tsmyadmin/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { closeStoresAfterEach, fixtureAdapter, harness, LOGIN, testConfig } from './test/app-harness.ts'

const stores = closeStoresAfterEach()

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
