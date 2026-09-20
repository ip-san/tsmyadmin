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
  savedItemLimit?: number
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

    it('keeps a second factor per account, where the store has somewhere to put it', async () => {
      const store = await create({ adapterFactory: tracked().adapterFactory, sweepIntervalMs: 0 })
      try {
        const factor = store.secondFactor
        if (!factor) {
          // The in-memory store has none, which is why requiring a second factor needs a persistent one.
          expect(store.secondFactor).toBeUndefined()
          return
        }
        expect(await factor.get(CONFIG)).toBeNull()
        await factor.set(CONFIG, { secret: 'JBSWY3DPEHPK3PXP', lastStep: 7, recoveryHashes: ['a', 'b'], at: 1 })
        const stored = await factor.get(CONFIG)
        expect(stored).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP', lastStep: 7, recoveryHashes: ['a', 'b'], at: 1 })

        // Written against what was read: the first write lands, a second one carrying the same (now stale)
        // version does not — which is what stops two logins with one code from both being accepted.
        expect(stored && (await factor.set(CONFIG, { ...stored, lastStep: 8 }))).toBe(true)
        expect(stored && (await factor.set(CONFIG, { ...stored, lastStep: 99 }))).toBe(false)
        expect(await factor.get(CONFIG)).toMatchObject({ lastStep: 8 })
        // Another account has its own, and cannot see this one.
        expect(await factor.get({ ...CONFIG, user: 'someone-else' })).toBeNull()
        // Replaced in place: one row per account, whatever the account does.
        expect(await factor.set(CONFIG, { secret: 'JBSWY3DPEHPK3PXP', lastStep: 9, recoveryHashes: [], at: 2 })).toBe(
          true
        )
        expect(await factor.get(CONFIG)).toMatchObject({ lastStep: 9, recoveryHashes: [] })
        await factor.clear({ ...CONFIG, user: 'someone-else' })
        expect(await factor.get(CONFIG)).not.toBeNull()
        // Removed against what was read, like a write: not once something has been written since.
        const read = await factor.get(CONFIG)
        expect(read && (await factor.set(CONFIG, { ...read, lastStep: 10 }))).toBe(true)
        expect(await factor.clear(CONFIG, read?.version)).toBe(false)
        expect(await factor.get(CONFIG)).toMatchObject({ lastStep: 10 })
        expect(await factor.clear(CONFIG, (await factor.get(CONFIG))?.version)).toBe(true)
        expect(await factor.get(CONFIG)).toBeNull()
        await factor.set(CONFIG, { secret: 'JBSWY3DPEHPK3PXP', lastStep: 1, recoveryHashes: [], at: 3 })
        expect(await factor.clear(CONFIG)).toBe(true)
        expect(await factor.get(CONFIG)).toBeNull()
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
        expect(await saved.save(CONFIG, 'sql', 'daily', 'SELECT 1')).toMatchObject([
          { name: 'daily', body: 'SELECT 1' },
        ])
        // Replaced by name rather than added twice, and invisible to a different account.
        expect(await saved.save(CONFIG, 'sql', 'daily', 'SELECT 2')).toHaveLength(1)
        expect(await saved.list({ ...CONFIG, user: 'someone-else' }, 'sql')).toEqual([])
        const id = (await saved.list(CONFIG, 'sql'))[0]?.id ?? ''
        expect(await saved.remove({ ...CONFIG, user: 'someone-else' }, 'sql', id)).toEqual([])
        expect(await saved.list(CONFIG, 'sql')).toHaveLength(1)
        expect(await saved.remove(CONFIG, 'sql', id)).toEqual([])

        // Export templates share the rows but are a separate list: the same name in both kinds is two items.
        await saved.save(CONFIG, 'sql', 'nightly', 'SELECT 3')
        expect(await saved.save(CONFIG, 'export', 'nightly', '{"database":"shop"}')).toMatchObject([
          { name: 'nightly', body: '{"database":"shop"}' },
        ])
        expect(await saved.list(CONFIG, 'sql')).toMatchObject([{ name: 'nightly', body: 'SELECT 3' }])
        const template = (await saved.list(CONFIG, 'export'))[0]?.id ?? ''

        // `replaces` drops that row in the same write as the new one, so a row stored under an older key does
        // not linger beside its replacement (and the account is never counted as holding both).
        const replaced = await saved.save(CONFIG, 'export', 'renamed', '{"database":"shop"}', template)
        expect(replaced.map((item) => item.name)).toEqual(['renamed'])
        // An id of another kind, of another account, or one that is simply gone, replaces nothing.
        const other = (await saved.list(CONFIG, 'sql'))[0]?.id ?? ''
        expect(await saved.save(CONFIG, 'export', 'kept', '{"database":"shop"}', other)).toHaveLength(2)
        expect(await saved.list(CONFIG, 'sql')).toHaveLength(1)
        await saved.save({ ...CONFIG, user: 'someone-else' }, 'export', 'theirs', '{"database":"shop"}')
        const theirs = (await saved.list({ ...CONFIG, user: 'someone-else' }, 'export'))[0]?.id ?? ''
        expect(await saved.save(CONFIG, 'export', 'kept', '{"database":"blog"}', theirs)).toHaveLength(2)
        expect(await saved.list({ ...CONFIG, user: 'someone-else' }, 'export')).toHaveLength(1)
        expect(await saved.save(CONFIG, 'export', 'kept', '{"database":"blog"}', 'gone')).toHaveLength(2)

        // Replacing a row with itself keeps it: the write must not delete what it just stored. Compared by name
        // rather than in order: two rows written in the same millisecond tie, and which comes first is not the
        // point here (the store has no injected clock in this case).
        const self = (await saved.list(CONFIG, 'export')).find((item) => item.name === 'kept')?.id ?? ''
        const kept = await saved.save(CONFIG, 'export', 'kept', '{"database":"shop"}', self)
        expect(kept.map((item) => item.name).sort()).toEqual(['kept', 'renamed'])

        for (const item of await saved.list(CONFIG, 'export')) await saved.remove(CONFIG, 'export', item.id)
        expect(await saved.list(CONFIG, 'export')).toEqual([])
        expect(await saved.list(CONFIG, 'sql')).toHaveLength(1)
      } finally {
        await store.closeAll()
      }
    })

    it('caps stored items per kind, so one kind filling up never evicts another', async () => {
      let t = 1_000
      const store = await create({
        adapterFactory: tracked().adapterFactory,
        sweepIntervalMs: 0,
        savedItemLimit: 3,
        now: () => ++t,
      })
      try {
        const saved = store.savedQueries
        if (!saved) return
        await saved.save(CONFIG, 'prefs', 'preferences', '{}')
        for (const n of ['a', 'b', 'c', 'd', 'e']) await saved.save(CONFIG, 'sql', n, 'SELECT 1')
        // The oldest bookmarks made room for the newest; the preferences, older than all of them, stayed.
        expect((await saved.list(CONFIG, 'sql')).map((q) => q.name)).toEqual(['e', 'd', 'c'])
        expect(await saved.list(CONFIG, 'prefs')).toHaveLength(1)
        // Replacing by name is not a new item, and evicts nothing.
        await saved.save(CONFIG, 'sql', 'c', 'SELECT 3')
        expect((await saved.list(CONFIG, 'sql')).map((q) => q.name).sort()).toEqual(['c', 'd', 'e'])
        for (const n of ['x', 'y', 'z']) await saved.save(CONFIG, 'central', n, '{}')
        expect(await saved.list(CONFIG, 'central')).toHaveLength(3)
        expect(await saved.list(CONFIG, 'sql')).toHaveLength(3)
        // Saves at once each see room for themselves; the kind still ends at its cap.
        await Promise.all(['p', 'q', 'r', 's', 't'].map((n) => saved.save(CONFIG, 'transform', n, '{}')))
        expect(await saved.list(CONFIG, 'transform')).toHaveLength(3)
        // Saves of one name at once are one item, not several (tracking numbers its versions by name).
        await Promise.all([1, 2, 3].map((n) => saved.save(CONFIG, 'prefs', 'twice', JSON.stringify({ n }))))
        expect((await saved.list(CONFIG, 'prefs')).filter((item) => item.name === 'twice')).toHaveLength(1)
      } finally {
        await store.closeAll()
      }
    })

    it('applies updates made at once one after the other, each seeing the one before', async () => {
      const store = await create({ adapterFactory: tracked().adapterFactory, sweepIntervalMs: 0 })
      try {
        const saved = store.savedQueries
        if (!saved) return
        const add = (n: number) =>
          saved.update(CONFIG, 'prefs', 'counter', (current) =>
            JSON.stringify([...JSON.parse(current?.body ?? '[]'), n])
          )
        await Promise.all([1, 2, 3, 4, 5, 6].map(add))
        const [row] = await saved.list(CONFIG, 'prefs')
        expect((JSON.parse(row?.body ?? '[]') as number[]).sort()).toEqual([1, 2, 3, 4, 5, 6])
        // Returning null writes nothing; throwing refuses and leaves the row as it was.
        const before = await saved.list(CONFIG, 'prefs')
        expect(await saved.update(CONFIG, 'prefs', 'counter', () => null)).toEqual(before)
        await expect(
          saved.update(CONFIG, 'prefs', 'counter', () => {
            throw new Error('refused')
          })
        ).rejects.toThrow('refused')
        expect(await saved.list(CONFIG, 'prefs')).toEqual(before)
      } finally {
        await store.closeAll()
      }
    })

    it('shares server-wide items between the accounts of one server, and only that server', async () => {
      const store = await create({ adapterFactory: tracked().adapterFactory, sweepIntervalMs: 0 })
      try {
        const shared = store.sharedItems
        if (!shared) {
          expect(store.savedQueries).toBeUndefined()
          return
        }
        await shared.save(CONFIG, 'usergroup', 'readers', '{}')
        // Another account of the same server sees it (and the host is compared the way the server would).
        expect(await shared.list({ ...CONFIG, user: 'someone-else', host: 'H' }, 'usergroup')).toMatchObject([
          { name: 'readers' },
        ])
        // Another server does not, and it is not one of the account's own items either.
        expect(await shared.list({ ...CONFIG, port: 2 }, 'usergroup')).toEqual([])
        expect(await store.savedQueries?.list(CONFIG, 'usergroup')).toEqual([])
        const id = (await shared.list(CONFIG, 'usergroup'))[0]?.id ?? ''
        expect(await shared.remove({ ...CONFIG, port: 2 }, 'usergroup', id)).toEqual([])
        expect(await shared.list(CONFIG, 'usergroup')).toHaveLength(1)
        expect(await shared.remove({ ...CONFIG, user: 'someone-else' }, 'usergroup', id)).toEqual([])
      } finally {
        await store.closeAll()
      }
    })
  })
}
