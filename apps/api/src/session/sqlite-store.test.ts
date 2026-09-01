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

describe('SqliteSessionStore', () => {
  it('creates, fetches, deletes and closes adapters like the memory store', async () => {
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's',
      rebuild: () => new FakeAdapter(),
      sweepIntervalMs: 0,
    })
    const adapter = new FakeAdapter()
    const s = await store.create(config, adapter)
    expect((await store.get(s.id))?.adapter).toBe(adapter)
    expect((await store.get(s.id))?.config.password).toBe('secret-pw')
    await store.delete(s.id)
    expect(await store.get(s.id)).toBeUndefined()
    expect(adapter.closed).toBe(true)
    await store.ping()
    await store.closeAll()
  })

  it('stores credentials encrypted at rest', async () => {
    const path = tmpFile()
    const store = new SqliteSessionStore({ path, secret: 's', rebuild: () => new FakeAdapter(), sweepIntervalMs: 0 })
    await store.create(config, new FakeAdapter())
    await store.closeAll()
    const raw = new DatabaseSync(path)
    const row = raw.prepare('SELECT payload FROM sessions').get() as { payload: Uint8Array }
    expect(Buffer.from(row.payload).toString('utf8')).not.toContain('secret-pw')
    raw.close()
  })

  it('survives a restart: a new process rebuilds the adapter from the stored config', async () => {
    const path = tmpFile()
    const first = new SqliteSessionStore({ path, secret: 's', rebuild: () => new FakeAdapter(), sweepIntervalMs: 0 })
    const s = await first.create(config, new FakeAdapter())
    await first.closeAll()

    const rebuilt: FakeAdapter[] = []
    const second = new SqliteSessionStore({
      path,
      secret: 's',
      rebuild: (cfg) => {
        expect(cfg).toEqual(config)
        const a = new FakeAdapter()
        rebuilt.push(a)
        return a
      },
      sweepIntervalMs: 0,
    })
    const resumed = await second.get(s.id)
    expect(resumed?.config.user).toBe('u')
    expect(rebuilt).toHaveLength(1)
    expect((await second.get(s.id))?.adapter).toBe(rebuilt[0]) // cached, not rebuilt again
    await second.closeAll()
  })

  it('drops sessions sealed with a different secret instead of failing', async () => {
    const path = tmpFile()
    const a = new SqliteSessionStore({ path, secret: 'one', rebuild: () => new FakeAdapter(), sweepIntervalMs: 0 })
    const s = await a.create(config, new FakeAdapter())
    await a.closeAll()
    const b = new SqliteSessionStore({ path, secret: 'two', rebuild: () => new FakeAdapter(), sweepIntervalMs: 0 })
    expect(await b.get(s.id)).toBeUndefined()
    expect(b.size).toBe(0)
    await b.closeAll()
  })

  it('applies a sliding TTL, throttles touch writes and sweeps stale rows', async () => {
    let t = 1000
    const store = new SqliteSessionStore({
      path: ':memory:',
      secret: 's',
      rebuild: () => new FakeAdapter(),
      ttlMs: 100,
      touchIntervalMs: 50,
      sweepIntervalMs: 0,
      now: () => t,
    })
    const adapter = new FakeAdapter()
    const s = await store.create(config, adapter)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // touched (80 ≥ 50)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // still alive thanks to the touch
    t += 150
    expect(await store.get(s.id)).toBeUndefined()
    expect(adapter.closed).toBe(true)

    const b = new FakeAdapter()
    const sb = await store.create(config, b)
    t += 200
    await store.sweep()
    expect(store.size).toBe(0)
    expect(b.closed).toBe(true)
    expect(await store.get(sb.id)).toBeUndefined()
    await store.closeAll()
  })
})
