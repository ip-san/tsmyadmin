import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSessionStore } from './sqlite-store.ts'

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret-pw' }
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsmyadmin-sessions-'))
  dirs.push(dir)
  return join(dir, 'nested', 'sessions.sqlite')
}
const factory =
  (made: FakeAdapter[] = []) =>
  () => {
    const a = new FakeAdapter()
    made.push(a)
    return a
  }

describe('SqliteSessionStore', () => {
  it('creates, fetches, deletes and closes adapters like the memory store', async () => {
    const made: FakeAdapter[] = []
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's',
      adapterFactory: factory(made),
      sweepIntervalMs: 0,
    })
    const s = await store.create(config)
    expect((await store.get(s.id))?.adapter).toBe(made[0])
    expect((await store.get(s.id))?.config.password).toBe('secret-pw')
    await store.delete(s.id)
    expect(await store.get(s.id)).toBeUndefined()
    expect(made[0]?.closed).toBe(true)
    await store.ping()
    await store.closeAll()
  })

  it('stores credentials encrypted at rest', async () => {
    const path = tmpFile()
    const store = new SqliteSessionStore({ path, secret: 's', adapterFactory: factory(), sweepIntervalMs: 0 })
    await store.create(config)
    await store.closeAll()
    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT payload FROM sessions').get() as { payload: Uint8Array }
    expect(Buffer.from(row.payload).toString('utf8')).not.toContain('secret-pw')
    raw.close()
  })

  it('survives a restart: a new process rebuilds the adapter once from the stored config', async () => {
    const path = tmpFile()
    const first = new SqliteSessionStore({ path, secret: 's', adapterFactory: factory(), sweepIntervalMs: 0 })
    const s = await first.create(config)
    await first.closeAll()

    const rebuilt: FakeAdapter[] = []
    const second = new SqliteSessionStore({
      path,
      secret: 's',
      adapterFactory: (cfg) => {
        expect(cfg).toEqual(config)
        return factory(rebuilt)()
      },
      sweepIntervalMs: 0,
    })
    const resumed = await second.get(s.id)
    expect(resumed?.config.user).toBe('u')
    expect(rebuilt).toHaveLength(1)
    expect((await second.get(s.id))?.adapter).toBe(rebuilt[0]) // cached: no second rebuild, no second decrypt
    await second.closeAll()
  })

  it('drops sessions sealed with a different secret instead of failing', async () => {
    const path = tmpFile()
    const a = new SqliteSessionStore({ path, secret: 'one', adapterFactory: factory(), sweepIntervalMs: 0 })
    const s = await a.create(config)
    await a.closeAll()
    const b = new SqliteSessionStore({ path, secret: 'two', adapterFactory: factory(), sweepIntervalMs: 0 })
    expect(await b.get(s.id)).toBeUndefined()
    expect(b.size).toBe(0)
    await b.closeAll()
  })

  it('applies a sliding TTL, throttles touch writes and sweeps stale rows', async () => {
    let t = 1000
    const made: FakeAdapter[] = []
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's',
      adapterFactory: factory(made),
      ttlMs: 100,
      touchIntervalMs: 50,
      sweepIntervalMs: 0,
      now: () => t,
    })
    const s = await store.create(config)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // touched (80 ≥ 50)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // still alive thanks to the touch
    t += 150
    expect(await store.get(s.id)).toBeUndefined()
    expect(made[0]?.closed).toBe(true)

    const sb = await store.create(config)
    t += 200
    await store.sweep()
    expect(store.size).toBe(0)
    expect(made[1]?.closed).toBe(true)
    expect(await store.get(sb.id)).toBeUndefined()
    await store.closeAll()
  })
})
