import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { describeSessionStoreConformance } from './conformance.ts'
import { RedisSessionStore } from './redis-store.ts'

const url = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:16379'
const SECRET = 's'.repeat(32)

// A namespace per store, so parallel legs cannot see each other's keys and nothing outlives the run.
describeSessionStoreConformance(
  'redis',
  (options) => new RedisSessionStore({ ...options, url, secret: SECRET, prefix: `test-${randomUUID()}` })
)

describe('RedisSessionStore', () => {
  it('does not bring a signed-out session back when a request for it was already in flight', async () => {
    // Replica A is serving a request for the session: it has read the payload and is about to slide the TTL.
    // Replica B signs the session out in between. A's write must not recreate the session's hash — an entry with
    // `at` and `identity` but no payload, which would then be counted against the cap for a whole TTL and evict a
    // real session at the next login.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const opts = { url, secret: SECRET, prefix, adapterFactory: () => new FakeAdapter(), maxPerIdentity: 3 }
    const a = new RedisSessionStore(opts)
    const b = new RedisSessionStore(opts)
    const { Redis } = await import('ioredis')
    const raw = new Redis(url)
    try {
      const first = await a.create(config)
      const second = await a.create(config)
      const third = await a.create(config)
      // Interleave on the real code path: B's sign-out lands inside A's request.
      const client = (a as unknown as { redis: { hget: (...args: unknown[]) => Promise<unknown> } }).redis
      const original = client.hget.bind(client)
      let interleaved = false
      // After A reads `at` (so A still believes the session is live) and before A's sliding write.
      client.hget = async (...args: unknown[]) => {
        const value = await original(...args)
        if (!interleaved && args[0] === `${prefix}:session:${third.id}` && args[1] === 'at') {
          interleaved = true
          await b.delete(third.id)
        }
        return value
      }
      await a.get(third.id)
      client.hget = original
      expect(interleaved).toBe(true)
      expect(await raw.exists(`${prefix}:session:${third.id}`)).toBe(0)
      // Two live sessions under a cap of three: the next login must evict neither.
      await a.create(config)
      expect(await a.get(first.id)).toBeDefined()
      expect(await a.get(second.id)).toBeDefined()
    } finally {
      await raw.quit()
      await a.closeAll()
      await b.closeAll()
    }
  })

  it('clears a payload-less leftover, index member included, when a request names it', async () => {
    // There is no payload to decrypt, so the identity stored in the hash is the only way to find its index.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const store = new RedisSessionStore({ url, secret: SECRET, prefix, adapterFactory: () => new FakeAdapter() })
    const { Redis } = await import('ioredis')
    const raw = new Redis(url)
    try {
      await store.create(config)
      const [index] = await raw.keys(`${prefix}:identity:*`)
      const leftover = randomUUID()
      const identity = String(index).slice(`${prefix}:identity:`.length)
      await raw.hset(`${prefix}:session:${leftover}`, 'at', Date.now(), 'identity', identity)
      await raw.zadd(index as string, Date.now(), leftover)
      expect(await store.get(leftover)).toBeUndefined()
      expect(await raw.exists(`${prefix}:session:${leftover}`)).toBe(0)
      expect(await raw.zrange(index as string, '0', '-1')).not.toContain(leftover)
    } finally {
      await raw.quit()
      await store.closeAll()
    }
  })

  it('does not count a hash without a payload, as older versions left behind, against the cap', async () => {
    // Before the sliding write was made conditional, a sign-out racing an in-flight request recreated the hash with
    // `at` and `identity` and no payload, and put the index member back. A rolling upgrade can still meet those.
    // Such a key exists, so counting by existence would evict a live session for it.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const store = new RedisSessionStore({
      url,
      secret: SECRET,
      prefix,
      adapterFactory: () => new FakeAdapter(),
      maxPerIdentity: 3,
    })
    const { Redis } = await import('ioredis')
    const raw = new Redis(url)
    try {
      const first = await store.create(config)
      const second = await store.create(config)
      const [index] = await raw.keys(`${prefix}:identity:*`)
      const leftover = randomUUID()
      const identity = String(index).slice(`${prefix}:identity:`.length)
      await raw.hset(`${prefix}:session:${leftover}`, 'at', Date.now(), 'identity', identity)
      await raw.zadd(index as string, Date.now(), leftover)
      await store.create(config)
      expect(await store.get(first.id)).toBeDefined()
      expect(await store.get(second.id)).toBeDefined()
      // And it is cleared rather than left to linger until the TTL sweep.
      expect(await raw.zcard(index as string)).toBe(3)
    } finally {
      await raw.quit()
      await store.closeAll()
    }
  })

  it('writes the identity field back on use, so old sessions stop needing the fallback', async () => {
    // The fallback decrypts the payload to find the identity, which is fine but happens on every delete of an
    // old session. Touching a session heals it instead, so a rolling upgrade converges as people use the app.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const store = new RedisSessionStore({ url, secret: SECRET, prefix, adapterFactory: () => new FakeAdapter() })
    const { Redis } = await import('ioredis')
    const raw = new Redis(url)
    try {
      const session = await store.create(config)
      await raw.hdel(`${prefix}:session:${session.id}`, 'identity')
      expect(await raw.hget(`${prefix}:session:${session.id}`, 'identity')).toBeNull()
      expect(await store.get(session.id)).toBeDefined()
      expect(await raw.hget(`${prefix}:session:${session.id}`, 'identity')).not.toBeNull()
    } finally {
      await raw.quit()
      await store.closeAll()
    }
  })

  it('handles a session written before the identity field existed', async () => {
    // During a rolling upgrade every session already in Redis is in exactly this state: the hash has no
    // `identity` field, and the replica that ends up serving the sign-out never held its pool. Without a way to
    // derive the identity, the index keeps a tombstone and the next login evicts a live session.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const opts = { url, secret: SECRET, prefix, adapterFactory: () => new FakeAdapter(), maxPerIdentity: 3 }
    const a = new RedisSessionStore(opts)
    const b = new RedisSessionStore(opts)
    const { Redis } = await import('ioredis')
    const raw = new Redis(url)
    try {
      const first = await a.create(config)
      const second = await a.create(config)
      const third = await a.create(config)
      // Make it look as an older version wrote it.
      await raw.hdel(`${prefix}:session:${third.id}`, 'identity')
      await b.delete(third.id)
      // B never held the pool and the hash has no identity: only decrypting the payload can name the index, so the
      // member must already be gone here, before a login gets the chance to tidy the index and mask a failure.
      const [index] = await raw.keys(`${prefix}:identity:*`)
      expect(await raw.zrange(index as string, '0', '-1')).not.toContain(third.id)
      await a.create(config)
      expect(await a.get(first.id)).toBeDefined()
      expect(await a.get(second.id)).toBeDefined()
    } finally {
      await raw.quit()
      await a.closeAll()
      await b.closeAll()
    }
  })

  it('does not evict a live session because another replica signed one out', async () => {
    // The whole point of this store is that a request can land on any replica, so a sign-out routinely happens
    // somewhere that never held that session's pool. If the index keeps the member, the next login counts it as
    // held and evicts a real session to make room it does not need — a user silently signed out elsewhere.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const opts = { url, secret: SECRET, prefix, adapterFactory: () => new FakeAdapter(), maxPerIdentity: 3 }
    const a = new RedisSessionStore(opts)
    const b = new RedisSessionStore(opts)
    try {
      const first = await a.create(config)
      const second = await a.create(config)
      const third = await a.create(config)
      // The sign-out arrives at the other replica.
      await b.delete(third.id)
      // The member goes at sign-out, from the identity stored with the session — not later, when a login happens to
      // read the index and tidy it (which would hide a broken lookup here).
      const { Redis } = await import('ioredis')
      const raw = new Redis(url)
      const [index] = await raw.keys(`${prefix}:identity:*`)
      expect(await raw.zrange(index as string, '0', '-1')).not.toContain(third.id)
      await raw.quit()
      expect(await a.get(third.id)).toBeUndefined()
      // Two live sessions under a cap of three: this must evict nothing.
      await a.create(config)
      expect(await a.get(first.id)).toBeDefined()
      expect(await a.get(second.id)).toBeDefined()
    } finally {
      await a.closeAll()
      await b.closeAll()
    }
  })

  it('lets another replica pick up a session it never created', async () => {
    // The point of the whole store: one process signs the user in, a different one serves the next request.
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'secret' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const a = new RedisSessionStore({
      url,
      secret: SECRET,
      prefix,
      adapterFactory: () => new FakeAdapter(),
      sweepIntervalMs: 0,
    })
    const b = new RedisSessionStore({
      url,
      secret: SECRET,
      prefix,
      adapterFactory: () => new FakeAdapter(),
      sweepIntervalMs: 0,
    })
    try {
      const s = await a.create(config)
      const onB = await b.get(s.id)
      expect(onB?.config.user).toBe('u')
      // Each replica builds its own pool for it — the adapter is process-local by design.
      expect(onB?.adapter).not.toBe(s.adapter)

      // Saved queries follow the account, not the replica.
      await a.savedQueries.save(config, 'sql', 'daily', 'SELECT 1')
      expect(await b.savedQueries.list(config, 'sql')).toMatchObject([{ name: 'daily', body: 'SELECT 1' }])

      // Signing out on one replica ends the session everywhere.
      await b.delete(s.id)
      expect(await a.get(s.id)).toBeUndefined()
    } finally {
      await a.closeAll()
      await b.closeAll()
    }
  })

  it('stores credentials sealed and bound to their key, never in the clear', async () => {
    const prefix = `test-${randomUUID()}`
    const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'hunter2' }
    const { FakeAdapter } = await import('@tsmyadmin/adapter/testing')
    const s = new RedisSessionStore({
      url,
      secret: SECRET,
      prefix,
      adapterFactory: () => new FakeAdapter(),
      sweepIntervalMs: 0,
    })
    const { Redis } = await import('ioredis')
    const raw = new Redis(url)
    try {
      const session = await s.create(config)
      const payload = await raw.hgetBuffer(`${prefix}:session:${session.id}`, 'payload')
      expect(payload).not.toBeNull()
      expect(payload?.toString('latin1')).not.toContain('hunter2')

      // Bound to its key: the very same bytes under another session id do not open, so someone who can write
      // to Redis but not decrypt it cannot promote themselves by copying a session.
      const other = randomUUID()
      await raw.hset(`${prefix}:session:${other}`, 'payload', payload ?? Buffer.alloc(0), 'at', Date.now())
      expect(await s.get(other)).toBeUndefined()
    } finally {
      await raw.quit()
      await s.closeAll()
    }
  })
})
