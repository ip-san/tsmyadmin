import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema, type SavedQuery } from '@tsmyadmin/shared'
import { Redis } from 'ioredis'
import { deriveSessionKey, open, rowAad, seal } from './crypto.ts'
import { identityHash } from './identity.ts'
import { SAVED_QUERIES, SAVED_QUERY_LIMIT } from './saved-queries.ts'
import {
  type AdapterFactory,
  connectAdapter,
  DEFAULT_MAX_SESSIONS_PER_IDENTITY,
  type SavedQueries,
  SESSION_TTL_MS,
  type Session,
  type SessionStore,
  startSweep,
} from './store.ts'

export interface RedisSessionStoreOptions {
  /** `redis://host:port` (or rediss:// for TLS). */
  url: string
  /** Session secret; the at-rest key is derived from it, exactly as for the SQLite store. */
  secret: string
  adapterFactory: AdapterFactory
  ttlMs?: number
  sweepIntervalMs?: number
  now?: () => number
  maxPerIdentity?: number
  /** Namespace for every key, so one Redis can hold more than one deployment. */
  prefix?: string
}

/** Table name in the AAD of a session payload, matching the SQLite store so the binding reads the same. */
const SESSIONS = 'sessions'

/**
 * Sessions in Redis, so several replicas can serve the same user.
 *
 * Read `docs/deployment.md` before assuming this makes the app replica-safe: the connection pools, the running
 * queries a cancel has to reach, and the login rate limiter all stay in the process that created them. What is
 * shared here is the session (so any replica can rebuild a pool from it) and the saved queries.
 *
 * Payloads are sealed exactly as in the file store — same key derivation, same row binding — so nothing about
 * the at-rest posture changes with the backend.
 */
export class RedisSessionStore implements SessionStore {
  private readonly redis: Redis
  private readonly key: Buffer
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly factory: AdapterFactory
  private readonly maxPerIdentity: number
  private readonly prefix: string
  /** Adapters are process-local: another replica holds its own pool for the same session. */
  private readonly live = new Map<string, { config: ConnectRequest; adapter: DatabaseAdapter; createdAt: number }>()
  private timer: ReturnType<typeof setInterval> | null
  readonly savedQueries: SavedQueries

  constructor(options: RedisSessionStoreOptions) {
    this.redis = new Redis(options.url, { maxRetriesPerRequest: 3, lazyConnect: false })
    this.key = deriveSessionKey(options.secret)
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? Date.now
    this.factory = options.adapterFactory
    this.maxPerIdentity = options.maxPerIdentity ?? DEFAULT_MAX_SESSIONS_PER_IDENTITY
    this.prefix = options.prefix ?? 'tsmyadmin'
    this.savedQueries = new RedisSavedQueries(this.redis, this.key, this.prefix, this.now)
    // Redis expires sessions itself; the sweep only closes the pools this process still holds for them.
    this.timer = startSweep(options.sweepIntervalMs ?? 60_000, () => void this.sweep())
  }

  private sessionKey(id: string): string {
    return `${this.prefix}:session:${id}`
  }

  private identityKey(identity: string): string {
    return `${this.prefix}:identity:${identity}`
  }

  /** Live pools only: the shared count is in Redis and not what the tests or the caller mean by "size". */
  get size(): number {
    return this.live.size
  }

  async create(config: ConnectRequest): Promise<Session> {
    const adapter = await connectAdapter(this.factory, config)
    const identity = identityHash(this.key, config)
    const index = this.identityKey(identity)
    // Evict the least recently used sessions of this account beyond the cap. The index is a sorted set scored
    // by last use, and Redis may already have expired members, so it is trimmed of those first.
    await this.redis.zremrangebyscore(index, '-inf', this.now() - this.ttlMs)
    const held = await this.redis.zrange(index, '0', '-1')
    for (const victim of held.slice(0, Math.max(0, held.length - this.maxPerIdentity + 1))) await this.delete(victim)

    const id = randomUUID()
    const now = this.now()
    const payload = seal(this.key, JSON.stringify(config), rowAad(SESSIONS, id))
    // `at` is kept beside the payload and the TTL is judged against it, rather than left to Redis's own clock.
    // That is what makes this store expire a session at the same moment the other two do — Redis expiring the
    // key is then just the cleanup that stops an abandoned session sitting there for ever.
    await this.redis
      .multi()
      .hset(this.sessionKey(id), 'payload', payload, 'at', now)
      .pexpire(this.sessionKey(id), this.ttlMs)
      .zadd(index, now, id)
      .pexpire(index, this.ttlMs)
      .exec()
    this.live.set(id, { config, adapter, createdAt: now })
    return { id, config, adapter, createdAt: now, lastUsedAt: now }
  }

  async get(id: string): Promise<Session | undefined> {
    const payload = await this.redis.hgetBuffer(this.sessionKey(id), 'payload')
    if (!payload) {
      // Expired in Redis, or ended on another replica: drop the pool this process was still holding.
      await this.closeLive(id)
      return undefined
    }
    if (this.now() - Number((await this.redis.hget(this.sessionKey(id), 'at')) ?? 0) > this.ttlMs) {
      await this.delete(id)
      return undefined
    }
    let live = this.live.get(id)
    if (!live) {
      let config: ConnectRequest
      try {
        config = ConnectRequestSchema.parse(JSON.parse(open(this.key, payload, rowAad(SESSIONS, id))))
      } catch {
        // Undecryptable (the secret was rotated) or corrupt: drop it rather than failing every request.
        await this.delete(id)
        return undefined
      }
      live = { config, adapter: this.factory(config), createdAt: this.now() }
      this.live.set(id, live)
    }
    const now = this.now()
    // Sliding TTL, on the session and on the index that orders it.
    const identity = this.identityKey(identityHash(this.key, live.config))
    await this.redis
      .multi()
      .hset(this.sessionKey(id), 'at', now)
      .pexpire(this.sessionKey(id), this.ttlMs)
      .zadd(identity, now, id)
      .pexpire(identity, this.ttlMs)
      .exec()
    return { id, config: live.config, adapter: live.adapter, createdAt: live.createdAt, lastUsedAt: now }
  }

  async delete(id: string): Promise<void> {
    const live = this.live.get(id)
    if (live) await this.redis.zrem(this.identityKey(identityHash(this.key, live.config)), id)
    await this.redis.del(this.sessionKey(id))
    await this.closeLive(id)
  }

  /** Closes and forgets the pool this process holds for a session, leaving Redis alone. */
  private async closeLive(id: string): Promise<void> {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    await live.adapter.close().catch(() => undefined)
  }

  /** Ends sessions past their TTL and releases pools whose session is gone (expired, or ended elsewhere). */
  async sweep(): Promise<void> {
    for (const id of [...this.live.keys()]) {
      const at = await this.redis.hget(this.sessionKey(id), 'at')
      if (at === null) {
        await this.closeLive(id)
      } else if (this.now() - Number(at) > this.ttlMs) {
        await this.delete(id)
      }
    }
  }

  async ping(): Promise<void> {
    await this.redis.ping()
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.live.keys()]) await this.closeLive(id)
    // Called more than once on a repeated stop signal; quit() on a closed client would reject.
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined)
  }
}

/**
 * Saved queries in Redis: one sorted set per account (scored by time, for the cap) plus one sealed value per
 * bookmark. Sealed and bound exactly as the SQLite rows are, and addressed by id for the same reason — the name
 * lives inside the payload, so there is nothing to look up by.
 */
class RedisSavedQueries implements SavedQueries {
  constructor(
    private readonly redis: Redis,
    private readonly key: Buffer,
    private readonly prefix: string,
    private readonly now: () => number
  ) {}

  private index(config: ConnectRequest): string {
    return `${this.prefix}:saved:${identityHash(this.key, config)}`
  }

  private entry(config: ConnectRequest, id: string): string {
    return `${this.index(config)}:${id}`
  }

  async list(config: ConnectRequest): Promise<SavedQuery[]> {
    const index = this.index(config)
    const ids = await this.redis.zrange(index, '0', '-1')
    const out: SavedQuery[] = []
    for (const id of ids) {
      const payload = await this.redis.getBuffer(this.entry(config, id))
      try {
        if (!payload) throw new Error('missing')
        const body = JSON.parse(open(this.key, payload, rowAad(SAVED_QUERIES, id))) as { name: string; sql: string }
        const at = (await this.redis.zscore(index, id)) ?? '0'
        out.push({ id, name: body.name, sql: body.sql, at: Number(at) })
      } catch {
        // Gone, or it will not open: the same dead weight the file store drops when it reads one.
        await this.redis.multi().zrem(index, id).del(this.entry(config, id)).exec()
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  async save(config: ConnectRequest, name: string, sql: string): Promise<SavedQuery[]> {
    const index = this.index(config)
    const existing = (await this.list(config)).find((q) => q.name === name)
    const id = existing?.id ?? randomUUID()
    const at = this.now()
    await this.redis
      .multi()
      .set(this.entry(config, id), seal(this.key, JSON.stringify({ name, sql }), rowAad(SAVED_QUERIES, id)))
      .zadd(index, at, id)
      .exec()
    // Oldest first beyond the cap, so a runaway client cannot grow the store without bound.
    const ids = await this.redis.zrange(index, '0', '-1')
    for (const victim of ids.slice(0, Math.max(0, ids.length - SAVED_QUERY_LIMIT))) {
      await this.redis.multi().zrem(index, victim).del(this.entry(config, victim)).exec()
    }
    return this.list(config)
  }

  async remove(config: ConnectRequest, id: string): Promise<SavedQuery[]> {
    // Scoped to the caller's own index, so an id belonging to another account matches nothing.
    await this.redis.multi().zrem(this.index(config), id).del(this.entry(config, id)).exec()
    return this.list(config)
  }
}
