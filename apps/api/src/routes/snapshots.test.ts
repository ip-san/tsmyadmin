import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import { SnapshotListSchema, SnapshotRestorePreviewSchema, SnapshotRestoreResultSchema } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { SNAPSHOT_MAX_COUNT } from '../lib/snapshots.ts'
import { MemorySessionStore } from '../session/store.ts'

const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'root', password: 'pw' }

function harness() {
  const adapter = new FakeAdapter({
    databases: {
      shop: {
        tables: {
          users: fakeTable('users', ['id', 'name'], [{ id: 1, name: 'Alice' }]),
          posts: fakeTable('posts', ['id', 'title'], [{ id: 1, title: 'hello' }]),
        },
      },
    },
    // One result per statement of the script, as a server answers.
    onSql: (_ns, _sql, opts) =>
      (opts.statements ?? []).map((s, i) => ({
        kind: 'affected' as const,
        sql: s.sql,
        affectedRows: 0,
        durationMs: 1,
        statement: i,
      })),
  })
  const store = new MemorySessionStore({ adapterFactory: () => adapter, sweepIntervalMs: 0 })
  const app = createApp({ ...loadConfig({}), sessionSecret: 'x'.repeat(48), allowedHosts: ['db'] }, { store })
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    })
  const login = async (user = 'root') => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify({ ...LOGIN, user }) })
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  }
  return { adapter, store, req, login }
}

const stores: MemorySessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})
const take = (h: ReturnType<typeof harness>, name: string) =>
  h.req('/api/databases/shop/snapshots', { method: 'POST', body: JSON.stringify({ name }) })

describe('snapshots', () => {
  it('takes a snapshot of a database, lists it, and deletes it', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const empty = SnapshotListSchema.parse(await (await h.req('/api/databases/shop/snapshots')).json())
    expect(empty.snapshots).toEqual([])
    const res = await take(h, 'before migration')
    expect(res.status).toBe(200)
    const list = SnapshotListSchema.parse(await res.json())
    expect(list.snapshots).toHaveLength(1)
    expect(list.snapshots[0]).toMatchObject({ name: 'before migration', objects: 2 })
    expect(list.snapshots[0]?.bytes).toBeGreaterThan(0)
    const id = list.snapshots[0]?.id ?? ''
    expect((await h.req(`/api/databases/shop/snapshots/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await h.req(`/api/databases/shop/snapshots/${id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('previews what a restore drops (what was made since), then runs the dump over the rest', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    const id = SnapshotListSchema.parse(await (await take(h, 'a')).json()).snapshots[0]?.id ?? ''
    const before = SnapshotRestorePreviewSchema.parse(
      await (await h.req(`/api/databases/shop/snapshots/${id}/restore/preview`)).json()
    )
    expect(before.drops).toEqual([])
    expect(before.statements).toBeGreaterThan(0)
    // A table and a view made after the snapshot: views go first, and only what the snapshot lacks.
    const listed = await h.adapter.listTables({ database: 'shop' })
    h.adapter.listTables = async () => [
      ...listed,
      { ...(listed[0] as (typeof listed)[number]), name: 'tmp_new', kind: 'table' },
      { ...(listed[0] as (typeof listed)[number]), name: 'v_new', kind: 'view' },
    ]
    const after = SnapshotRestorePreviewSchema.parse(
      await (await h.req(`/api/databases/shop/snapshots/${id}/restore/preview`)).json()
    )
    expect(after.drops).toEqual(['DROP VIEW IF EXISTS `shop`.`v_new`', 'DROP TABLE IF EXISTS `shop`.`tmp_new`'])
    const run = await h.req(`/api/databases/shop/snapshots/${id}/restore`, { method: 'POST' })
    expect(run.status).toBe(200)
    const result = SnapshotRestoreResultSchema.parse(await run.json())
    expect(result).toMatchObject({ failed: 0, errors: [] })
    expect(result.statements).toBe(after.statements + 2)
    const script = h.adapter.calls.filter((c) => c.method === 'executeSql').at(-1)
    // The option statements come first; then what was made since is dropped, then the dump itself.
    const text = String(script?.args[1])
    const drops = 'DROP VIEW IF EXISTS `shop`.`v_new`;\nDROP TABLE IF EXISTS `shop`.`tmp_new`;\n'
    expect(text).toContain(drops)
    expect(text.indexOf(drops)).toBeLessThan(text.indexOf('DROP TABLE IF EXISTS `users`'))
  })

  it('keeps a snapshot to the account that took it, and refuses past the count limit', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login('root')
    const id = SnapshotListSchema.parse(await (await take(h, 'mine')).json()).snapshots[0]?.id ?? ''
    await h.login('someone')
    expect(SnapshotListSchema.parse(await (await h.req('/api/databases/shop/snapshots')).json()).snapshots).toEqual([])
    expect((await h.req(`/api/databases/shop/snapshots/${id}/restore`, { method: 'POST' })).status).toBe(404)
    for (let i = 0; i < SNAPSHOT_MAX_COUNT; i++) expect((await take(h, `n${i}`)).status).toBe(200)
    const over = await take(h, 'one too many')
    expect(over.status).toBe(400)
    expect(await over.json()).toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses an empty name', async () => {
    const h = harness()
    stores.push(h.store)
    await h.login()
    expect((await take(h, '   ')).status).toBe(400)
  })
})
