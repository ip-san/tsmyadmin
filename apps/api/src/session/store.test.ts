import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { MemorySessionStore, sessionInfo } from './store.ts'

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }

describe('MemorySessionStore', () => {
  it('creates, fetches and deletes sessions, closing the adapter', async () => {
    const store = new MemorySessionStore({ sweepIntervalMs: 0 })
    const adapter = new FakeAdapter()
    const s = await store.create(config, adapter)
    expect((await store.get(s.id))?.config.user).toBe('u')
    await store.delete(s.id)
    expect(await store.get(s.id)).toBeUndefined()
    expect(adapter.closed).toBe(true)
  })

  it('expires sessions after the sliding TTL', async () => {
    let t = 1000
    const store = new MemorySessionStore({ ttlMs: 100, sweepIntervalMs: 0, now: () => t })
    const s = await store.create(config, new FakeAdapter())
    t += 80
    expect(await store.get(s.id)).toBeDefined() // touched → TTL slides
    t += 80
    expect(await store.get(s.id)).toBeDefined()
    t += 150
    expect(await store.get(s.id)).toBeUndefined()
  })

  it('sweep closes stale sessions and closeAll closes everything', async () => {
    let t = 0
    const store = new MemorySessionStore({ ttlMs: 10, sweepIntervalMs: 0, now: () => t })
    const a = new FakeAdapter()
    const b = new FakeAdapter()
    await store.create(config, a)
    t = 5
    const sb = await store.create(config, b)
    t = 12
    await store.sweep()
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(false)
    expect(store.size).toBe(1)
    await store.closeAll()
    expect(b.closed).toBe(true)
    expect(await store.get(sb.id)).toBeUndefined()
  })

  it('sessionInfo strips the password and ping resolves', async () => {
    const store = new MemorySessionStore({ sweepIntervalMs: 0 })
    const s = await store.create(config, new FakeAdapter())
    expect(sessionInfo(s)).toEqual({ dialect: 'mysql', host: 'h', port: 1, user: 'u' })
    expect('password' in sessionInfo(s)).toBe(false)
    await expect(store.ping()).resolves.toBeUndefined()
  })
})
