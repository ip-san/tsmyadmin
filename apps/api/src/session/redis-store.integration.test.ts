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
      await a.savedQueries.save(config, 'daily', 'SELECT 1')
      expect(await b.savedQueries.list(config)).toMatchObject([{ name: 'daily', sql: 'SELECT 1' }])

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
