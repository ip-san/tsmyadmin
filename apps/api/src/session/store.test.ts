import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { describe, expect, it } from 'vitest'
import { MemorySessionStore, sessionIdentity, sessionInfo } from './store.ts'

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }

describe('MemorySessionStore', () => {
  it('creates (ping + persist), fetches and deletes sessions, closing the adapter', async () => {
    const adapter = new FakeAdapter()
    const store = new MemorySessionStore({ adapterFactory: () => adapter, sweepIntervalMs: 0 })
    const s = await store.create(config)
    expect(adapter.calls[0]?.method).toBe('ping')
    expect((await store.get(s.id))?.config.user).toBe('u')
    await store.delete(s.id)
    expect(await store.get(s.id)).toBeUndefined()
    expect(adapter.closed).toBe(true)
  })

  it('closes the adapter and rethrows when the connection check fails', async () => {
    const adapter = new FakeAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') })
    const store = new MemorySessionStore({ adapterFactory: () => adapter, sweepIntervalMs: 0 })
    await expect(store.create(config)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    // FakeAdapter with failWith throws from close() too, so assert the attempt rather than the flag.
    expect(adapter.calls.map((c) => c.method)).toEqual(['ping', 'close'])
    expect(store.size).toBe(0)
  })

  it('expires sessions after the sliding TTL', async () => {
    let t = 1000
    const store = new MemorySessionStore({
      adapterFactory: () => new FakeAdapter(),
      ttlMs: 100,
      sweepIntervalMs: 0,
      now: () => t,
    })
    const s = await store.create(config)
    t += 80
    expect(await store.get(s.id)).toBeDefined() // touched → TTL slides
    t += 80
    expect(await store.get(s.id)).toBeDefined()
    t += 150
    expect(await store.get(s.id)).toBeUndefined()
  })

  it('sweep closes stale sessions and closeAll closes everything', async () => {
    let t = 0
    const adapters: FakeAdapter[] = []
    const store = new MemorySessionStore({
      adapterFactory: () => {
        const a = new FakeAdapter()
        adapters.push(a)
        return a
      },
      ttlMs: 10,
      sweepIntervalMs: 0,
      now: () => t,
    })
    await store.create(config)
    t = 5
    const sb = await store.create(config)
    t = 12
    await store.sweep()
    expect(adapters[0]?.closed).toBe(true)
    expect(adapters[1]?.closed).toBe(false)
    expect(store.size).toBe(1)
    await store.closeAll()
    expect(adapters[1]?.closed).toBe(true)
    expect(await store.get(sb.id)).toBeUndefined()
  })

  it('sessionInfo / sessionIdentity strip the password and ping resolves', async () => {
    const store = new MemorySessionStore({ adapterFactory: () => new FakeAdapter(), sweepIntervalMs: 0 })
    const s = await store.create(config)
    expect(sessionInfo(s)).toEqual({ dialect: 'mysql', host: 'h', port: 1, user: 'u' })
    expect('password' in sessionIdentity(config)).toBe(false)
    await expect(store.ping()).resolves.toBeUndefined()
  })
})
