import { AdapterError } from '@tsmyadmin/adapter'
import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import type { ConnectRequest } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { type AdapterFactory, type SessionStore, sessionIdentity, sessionInfo } from './store.ts'

/** What every store implementation takes; each one adds its own (a file path, a URL, a secret). */
export interface StoreOptions {
  adapterFactory: AdapterFactory
  ttlMs?: number
  maxPerIdentity?: number
  sweepIntervalMs?: number
  now?: () => number
}

/**
 * `size` and `sweep` are not part of `SessionStore` — the routes never need them — but both implementations
 * expose them and the contract below is much harder to state without them.
 */
export type TestableStore = SessionStore & { readonly size: number; sweep(): Promise<void> }

const CONFIG: ConnectRequest = { dialect: 'mysql', host: 'h', port: 1, user: 'u', password: 'secret' }

/**
 * The behaviour every session store owes the routes, run against each implementation.
 *
 * It exists because the contract was previously re-tested by hand per store — `sqlite-store.test.ts` had a case
 * literally named "…like the memory store" — which is how two implementations of one interface drift apart.
 * Anything specific to how a store persists (encryption, migrations, secret rotation) stays in its own file.
 */
export function describeSessionStoreConformance(
  name: string,
  create: (options: StoreOptions) => TestableStore | Promise<TestableStore>
): void {
  describe(`session store conformance (${name})`, () => {
    /** Collects the adapters a store built, so the tests can assert they were closed. */
    const tracked = () => {
      const made: FakeAdapter[] = []
      const adapterFactory: AdapterFactory = () => {
        const a = new FakeAdapter()
        made.push(a)
        return a
      }
      return { made, adapterFactory }
    }

    it('pings on create, then hands back the same session and adapter until it is deleted', async () => {
      const { made, adapterFactory } = tracked()
      const store = await create({ adapterFactory, sweepIntervalMs: 0 })
      try {
        const s = await store.create(CONFIG)
        expect(made[0]?.calls[0]?.method).toBe('ping')
        const got = await store.get(s.id)
        expect(got?.config.user).toBe('u')
        // The credentials come back whole: the store is what holds them for the connection pool.
        expect(got?.config.password).toBe('secret')
        expect(got?.adapter).toBe(made[0])
        await store.delete(s.id)
        expect(await store.get(s.id)).toBeUndefined()
        expect(made[0]?.closed).toBe(true)
      } finally {
        await store.closeAll()
      }
    })

    it('closes the half-built adapter and rethrows when the connection is refused', async () => {
      const adapter = new FakeAdapter({ failWith: new AdapterError('AUTH_FAILED', 'denied') })
      const store = await create({ adapterFactory: () => adapter, sweepIntervalMs: 0 })
      try {
        await expect(store.create(CONFIG)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
        // A FakeAdapter built with failWith throws from close() too, so the attempt is what can be asserted.
        expect(adapter.calls.map((c) => c.method)).toEqual(['ping', 'close'])
        // A refused login must leave nothing behind — otherwise a wrong password fills the store.
        expect(store.size).toBe(0)
      } finally {
        await store.closeAll()
      }
    })

    it('caps sessions per database account, evicting the least recently used', async () => {
      let t = 0
      const { made, adapterFactory } = tracked()
      const store = await create({ adapterFactory, maxPerIdentity: 2, sweepIntervalMs: 0, now: () => t++ })
      try {
        const a = await store.create(CONFIG)
        const b = await store.create(CONFIG)
        const other = await store.create({ ...CONFIG, user: 'someone-else' })
        // The host is matched case-insensitively, so this is the same account as `a` and `b`.
        const c = await store.create({ ...CONFIG, host: 'H' })
        expect(await store.get(a.id)).toBeUndefined()
        expect(made[0]?.closed).toBe(true)
        expect((await store.get(b.id))?.id).toBe(b.id)
        expect((await store.get(c.id))?.id).toBe(c.id)
        // Another account is unaffected by a neighbour's cap.
        expect((await store.get(other.id))?.id).toBe(other.id)
        expect(store.size).toBe(3)
      } finally {
        await store.closeAll()
      }
    })

    it('slides the TTL on every use and expires once it is untouched', async () => {
      let t = 1000
      const store = await create({
        adapterFactory: tracked().adapterFactory,
        ttlMs: 100,
        sweepIntervalMs: 0,
        now: () => t,
      })
      try {
        const s = await store.create(CONFIG)
        t += 80
        expect(await store.get(s.id)).toBeDefined()
        t += 80
        expect(await store.get(s.id)).toBeDefined()
        t += 150
        expect(await store.get(s.id)).toBeUndefined()
      } finally {
        await store.closeAll()
      }
    })

    it('sweeps only the stale sessions, and closeAll closes the rest', async () => {
      let t = 0
      const { made, adapterFactory } = tracked()
      const store = await create({ adapterFactory, ttlMs: 10, sweepIntervalMs: 0, now: () => t })
      try {
        await store.create(CONFIG)
        t = 5
        const fresh = await store.create(CONFIG)
        t = 12
        await store.sweep()
        expect(made[0]?.closed).toBe(true)
        expect(made[1]?.closed).toBe(false)
        expect(store.size).toBe(1)
        expect((await store.get(fresh.id))?.id).toBe(fresh.id)

        await store.closeAll()
        expect(made[1]?.closed).toBe(true)
        // Shutting down twice is a thing that happens (a repeated signal); it must not throw.
        await expect(store.closeAll()).resolves.toBeUndefined()
        // Reading after shutdown is deliberately not part of the contract: the memory store answers
        // `undefined`, a store holding a handle throws, and nothing calls a store it has already closed.
      } finally {
        await store.closeAll()
      }
    })

    it('answers ping, and never lets the password out through sessionInfo', async () => {
      const store = await create({ adapterFactory: tracked().adapterFactory, sweepIntervalMs: 0 })
      try {
        const s = await store.create(CONFIG)
        await expect(store.ping()).resolves.toBeUndefined()
        expect(sessionInfo(s)).toEqual({ dialect: 'mysql', host: 'h', port: 1, user: 'u' })
        expect('password' in sessionIdentity(CONFIG)).toBe(false)
      } finally {
        await store.closeAll()
      }
    })

    it('keeps saved queries per account, where the store has somewhere to put them', async () => {
      const store = await create({ adapterFactory: tracked().adapterFactory, sweepIntervalMs: 0 })
      try {
        const saved = store.savedQueries
        if (!saved) {
          // The in-memory store has none by design: they would vanish on restart, so the browser keeps its own.
          expect(store.savedQueries).toBeUndefined()
          return
        }
        expect(saved.save(CONFIG, 'daily', 'SELECT 1')).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }])
        // Replaced by name rather than added twice, and invisible to a different account.
        expect(saved.save(CONFIG, 'daily', 'SELECT 2')).toHaveLength(1)
        expect(saved.list({ ...CONFIG, user: 'someone-else' })).toEqual([])
        const id = saved.list(CONFIG)[0]?.id ?? ''
        expect(saved.remove({ ...CONFIG, user: 'someone-else' }, id)).toEqual([])
        expect(saved.list(CONFIG)).toHaveLength(1)
        expect(saved.remove(CONFIG, id)).toEqual([])
      } finally {
        await store.closeAll()
      }
    })
  })
}
