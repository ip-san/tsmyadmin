import { createHmac, randomUUID } from 'node:crypto'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema } from '@tsmyadmin/shared'
import { Redis } from 'ioredis'
import { deriveSessionKey, open, rowAad, seal } from './crypto.ts'
import { identityHash, serverHash } from './identity.ts'
import {
  overCap,
  type RowOwner,
  readPayload,
  SAVED_QUERIES,
  SAVED_QUERY_LIMIT,
  SHARED_ITEM_LIMIT,
} from './saved-queries.ts'
import { SECOND_FACTOR, version } from './second-factor.ts'
import {
  type AdapterFactory,
  connectAdapter,
  DEFAULT_MAX_SESSIONS_PER_IDENTITY,
  type SavedItem,
  type SavedItemKind,
  type SavedItems,
  SESSION_TTL_MS,
  type SecondFactor,
  type SecondFactors,
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
  /** Stored items kept per account and kind (tests lower it; the default matches the browser-side lists). */
  savedItemLimit?: number
  /** Namespace for every key, so one Redis can hold more than one deployment. */
  prefix?: string
  /**
   * Connection errors. ioredis reconnects on its own, so these are informational — but a listener must exist:
   * with none, ioredis falls back to `console.error` with a raw stack, which breaks the one-JSON-object-per-line
   * contract of LOG_FORMAT=json for every retry (roughly twice a second while Redis is down).
   */
  onError?: (error: Error) => void
}

/**
 * Splits index members by whether their session still exists, given one `HEXISTS … payload` reply per member.
 *
 * Only a reply that succeeded and said 0 proves a session is gone. A failed command says nothing, and treating it
 * as gone would drop a live session's index member: it would then be neither counted against the per-account cap
 * nor reachable for eviction, and would linger until its TTL.
 */
export function partitionByExistence(
  members: string[],
  replies: [Error | null, unknown][] | null
): { held: string[]; stale: string[] } {
  const held: string[] = []
  const stale: string[] = []
  for (const [i, id] of members.entries()) {
    const [error, exists] = replies?.[i] ?? [null, undefined]
    ;(error || exists !== 0 ? held : stale).push(id)
  }
  return { held, stale }
}

/**
 * Slides a session's TTL only while it still exists: KEYS[1] the session hash, KEYS[2] its account index;
 * ARGV now, identity, ttl (ms), session id. Returns 0 when the session was deleted in the meantime.
 */
const SLIDE_SESSION = `
if redis.call('HEXISTS', KEYS[1], 'payload') == 0 then return 0 end
redis.call('HSET', KEYS[1], 'at', ARGV[1], 'identity', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`

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
  readonly savedQueries: SavedItems
  readonly sharedItems: SavedItems
  readonly secondFactor: SecondFactors

  constructor(options: RedisSessionStoreOptions) {
    this.redis = new Redis(options.url, { maxRetriesPerRequest: 3, lazyConnect: false })
    const onError = options.onError
    // Always attached, even without a callback: an unhandled 'error' is what triggers ioredis's console.error.
    this.redis.on('error', (error: Error) => onError?.(error))
    this.key = deriveSessionKey(options.secret)
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? Date.now
    this.factory = options.adapterFactory
    this.maxPerIdentity = options.maxPerIdentity ?? DEFAULT_MAX_SESSIONS_PER_IDENTITY
    this.prefix = options.prefix ?? 'tsmyadmin'
    this.savedQueries = new RedisSavedQueries(
      this.redis,
      this.key,
      this.prefix,
      this.now,
      options.savedItemLimit ?? SAVED_QUERY_LIMIT
    )
    this.sharedItems = new RedisSavedQueries(
      this.redis,
      this.key,
      this.prefix,
      this.now,
      options.savedItemLimit ?? SHARED_ITEM_LIMIT,
      serverHash
    )
    this.secondFactor = new RedisSecondFactors(this.redis, this.key, this.prefix)
    // Redis expires sessions itself; the sweep only closes the pools this process still holds for them.
    // Redis being down makes every sweep fail; it is reported the way the client's own errors are, not thrown.
    this.timer = startSweep(
      options.sweepIntervalMs ?? 60_000,
      () => this.sweep(),
      onError ? (err) => onError(err instanceof Error ? err : new Error(String(err))) : undefined
    )
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

  async create(config: ConnectRequest, options: { keepOthers?: boolean } = {}): Promise<Session> {
    const adapter = await connectAdapter(this.factory, config)
    const identity = identityHash(this.key, config)
    const index = this.identityKey(identity)
    const id = randomUUID()
    const now = this.now()
    const payload = seal(this.key, JSON.stringify(config), rowAad(SESSIONS, id))
    // `at` is kept beside the payload and the TTL is judged against it, rather than left to Redis's own clock.
    // That is what makes this store expire a session at the same moment the other two do — Redis expiring the
    // key is then just the cleanup that stops an abandoned session sitting there for ever.
    await this.redis
      .multi()
      // `identity` is stored beside the payload so that a delete can find the index without help from `live`.
      .hset(this.sessionKey(id), 'payload', payload, 'at', now, 'identity', identity)
      .pexpire(this.sessionKey(id), this.ttlMs)
      .zadd(index, now, id)
      .pexpire(index, this.ttlMs)
      .exec()
    this.live.set(id, { config, adapter, createdAt: now })
    // Evicted after a successful connect, so a wrong password cannot be used to log other people out — and,
    // when a second factor is still to be checked, only once that has passed.
    if (!options.keepOthers) await this.enforceLimit(config, id)
    return { id, config, adapter, createdAt: now, lastUsedAt: now }
  }

  async enforceLimit(config: ConnectRequest, keep: string): Promise<void> {
    const index = this.identityKey(identityHash(this.key, config))
    // The index is a sorted set scored by last use, and Redis may already have expired members: trimmed first.
    await this.redis.zremrangebyscore(index, '-inf', this.now() - this.ttlMs)
    const held = (await this.heldSessions(index)).filter((id) => id !== keep)
    for (const victim of held.slice(0, Math.max(0, held.length - this.maxPerIdentity + 1))) await this.delete(victim)
  }

  /**
   * The index members that still have a session behind them, dropping any that do not.
   *
   * "Still there" means the hash has a payload, not merely that the key exists. Before the sliding write was made
   * conditional (see `get`), a sign-out racing an in-flight request left a hash holding only `at` and `identity`,
   * and a rolling upgrade can still meet those. Counting one would evict a live session to make room that was
   * never needed, so they are cleared here — the one place that already reads the whole index.
   */
  private async heldSessions(index: string): Promise<string[]> {
    const members = await this.redis.zrange(index, '0', '-1')
    if (members.length === 0) return members
    const pipeline = this.redis.pipeline()
    for (const id of members) pipeline.hexists(this.sessionKey(id), 'payload')
    const results = await pipeline.exec()
    const { held, stale } = partitionByExistence(members, results)
    if (stale.length > 0) await this.redis.zrem(index, ...stale)
    return held
  }

  async get(id: string): Promise<Session | undefined> {
    const payload = await this.redis.hgetBuffer(this.sessionKey(id), 'payload')
    if (!payload) {
      // Expired in Redis, or ended on another replica: drop the pool this process was still holding, and any
      // payload-less hash an older version left behind (delete removes its index member too).
      await this.delete(id)
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
    const identity = identityHash(this.key, live.config)
    const index = this.identityKey(identity)
    // Conditional and atomic: another replica may have signed this session out after the reads above. A plain
    // write would recreate the hash with `at` and `identity` but no payload — counted against the cap for a whole
    // TTL — and put the index member back. `identity` is written on every use so a session from before that field
    // existed heals the first time it is touched, which matters during a rolling upgrade.
    const slid = await this.redis.eval(SLIDE_SESSION, 2, this.sessionKey(id), index, now, identity, this.ttlMs, id)
    if (slid !== 1) {
      await this.closeLive(id)
      return undefined
    }
    return { id, config: live.config, adapter: live.adapter, createdAt: live.createdAt, lastUsedAt: now }
  }

  async delete(id: string): Promise<void> {
    // Read the identity from Redis rather than from `live`: this process may never have held this session's
    // pool — another replica signed the user out, or this one restarted. Deriving it only from `live` left the
    // sorted-set member behind, and `create` then counted that tombstone as a held session and evicted a real
    // one to make room it did not need.
    const live = this.live.get(id)
    const identity = (await this.redis.hget(this.sessionKey(id), 'identity')) ?? (await this.deriveIdentity(id, live))
    if (identity) await this.redis.zrem(this.identityKey(identity), id)
    await this.redis.del(this.sessionKey(id))
    await this.closeLive(id)
  }

  /**
   * The identity of a session whose hash predates the stored `identity` field — written by an older version and
   * still alive in Redis during a rolling upgrade. The pool this process holds answers it for free; otherwise the
   * payload is still there to be decrypted, since this runs before the key is deleted.
   */
  private async deriveIdentity(id: string, live: { config: ConnectRequest } | undefined): Promise<string | null> {
    if (live) return identityHash(this.key, live.config)
    const payload = await this.redis.hgetBuffer(this.sessionKey(id), 'payload')
    if (!payload) return null
    try {
      return identityHash(
        this.key,
        ConnectRequestSchema.parse(JSON.parse(open(this.key, payload, rowAad(SESSIONS, id))))
      )
    } catch {
      // Undecryptable: the secret was rotated, so the index entry is unreachable anyway and expires on its own.
      return null
    }
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
class RedisSavedQueries implements SavedItems {
  constructor(
    private readonly redis: Redis,
    private readonly key: Buffer,
    private readonly prefix: string,
    private readonly now: () => number,
    private readonly limit: number,
    private readonly owner: RowOwner = identityHash
  ) {}

  private index(config: ConnectRequest): string {
    return `${this.prefix}:saved:${this.owner(this.key, config)}`
  }

  /** A stable id for a new row: an HMAC under the store key, so it says nothing about the name it stands for. */
  private idFor(config: ConnectRequest, kind: SavedItemKind, name: string): string {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([this.owner(this.key, config), kind, name]))
      .digest('hex')
      .slice(0, 32)
  }

  private entry(config: ConnectRequest, id: string): string {
    return `${this.index(config)}:${id}`
  }

  async list(config: ConnectRequest, kind: SavedItemKind): Promise<SavedItem[]> {
    const index = this.index(config)
    const ids = await this.redis.zrange(index, '0', '-1')
    const out: SavedItem[] = []
    for (const id of ids) {
      const payload = await this.redis.getBuffer(this.entry(config, id))
      try {
        if (!payload) throw new Error('missing')
        const at = (await this.redis.zscore(index, id)) ?? '0'
        const item = readPayload(open(this.key, payload, rowAad(SAVED_QUERIES, id)), id, Number(at))
        if (item.kind === kind) out.push(item)
      } catch {
        // Gone, or it will not open: the same dead weight the file store drops when it reads one. Only while it is
        // still exactly what was read: `list` takes no lock, and a save may have written this id since.
        await this.redis.eval(PRUNE_IF_UNCHANGED, 2, index, this.entry(config, id), id, payload ?? '')
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  async save(
    config: ConnectRequest,
    kind: SavedItemKind,
    name: string,
    body: string,
    replaces?: string
  ): Promise<SavedItem[]> {
    // Under the same lock as `update` and `remove`: unlocked, a save landing inside an update was overwritten by the
    // update's stale result, and one landing inside a conditional removal was deleted by it.
    return this.withLock(config, kind, (fence) => this.write(fence, config, kind, name, body, replaces))
  }

  /** `save` for a caller that already holds the kind's lock (the lock is not re-entrant). */
  private async write(
    fence: Fence,
    config: ConnectRequest,
    kind: SavedItemKind,
    name: string,
    body: string,
    replaces?: string
  ): Promise<SavedItem[]> {
    const mine = await this.list(config, kind)
    const existing = mine.find((q) => q.name === name)
    // Never the row being written: replacing a row with itself would delete what this call just stored.
    const replaced = replaces === undefined ? undefined : mine.find((q) => q.id === replaces && q.id !== existing?.id)
    // A new row's id follows from what it is (owner, kind, name) rather than chance, so a replica still running a
    // version whose save took no lock lands on the same key instead of adding a second row of the name.
    const id = existing?.id ?? this.idFor(config, kind, name)
    const at = this.now()
    // Oldest of this kind first beyond its cap, so a runaway client cannot grow the store without bound. The kind
    // is inside the sealed payload, so the victims come from the opened list, not the index.
    const victims = existing
      ? []
      : overCap(
          mine.filter((q) => q.id !== replaced?.id),
          this.limit
        )
    // One script, so the row being replaced cannot survive a failed write of its replacement.
    const payload = seal(this.key, JSON.stringify({ kind, name, body }), rowAad(SAVED_QUERIES, id))
    const drop = [...(replaced ? [replaced.id] : []), ...victims.map((victim) => victim.id)]
    await this.fenced(fence, config, drop, { id, at, payload })
    // The lock keeps this replica's saves in turn, but during a rolling upgrade one without it can still have seen
    // room at the same time: whichever finishes second trims the kind back to its cap.
    const after = await this.list(config, kind)
    const excess = after.slice(this.limit)
    if (excess.length === 0) return after
    await this.fenced(
      fence,
      config,
      excess.map((victim) => victim.id)
    )
    return after.slice(0, this.limit)
  }

  /**
   * Drops the items `drop` (and first stores `put`, when given) only while the lock is still the caller's. A holder
   * that stalled past the lock's expiry has lost it — perhaps to another writer, who may have written since — so its
   * write, decided from what it read before, is refused, and `withLock` runs the whole read-modify-write again.
   */
  private async fenced(
    fence: Fence,
    config: ConnectRequest,
    drop: readonly string[],
    put?: { id: string; at: number; payload: Buffer }
  ): Promise<void> {
    const ids = put ? [put.id, ...drop] : [...drop]
    const keys = [fence.lock, this.index(config), ...ids.map((id) => this.entry(config, id))]
    const args = [fence.token, put ? String(put.at) : '', put?.payload ?? '', ...ids]
    if ((await this.redis.eval(FENCED_WRITE, keys.length, ...keys, ...args)) !== 1) throw new LockLost()
  }

  async update(
    config: ConnectRequest,
    kind: SavedItemKind,
    name: string,
    change: (current: SavedItem | undefined, all: readonly SavedItem[]) => string | null
  ): Promise<SavedItem[]> {
    return this.withLock(config, kind, async (fence) => {
      const mine = await this.list(config, kind)
      const body = change(
        mine.find((q) => q.name === name),
        mine
      )
      return body === null ? mine : this.write(fence, config, kind, name, body)
    })
  }

  /**
   * Runs `run` while holding this account's lock on the kind (a short-lived key), so read-modify-write updates from
   * every process sharing the Redis take turns. The lock expires on its own: a process that dies holding it delays
   * the others by a few seconds, not for good. A process that only stalls past the expiry is not trusted to still
   * hold it: every write inside `run` goes through `fenced`, which checks the lock is still this call's, and when it
   * is not, `run` starts again from its reads under a new lock (a few times, then the same "busy" as a lock that
   * never comes free).
   */
  private async withLock<T>(
    config: ConnectRequest,
    kind: SavedItemKind,
    run: (fence: Fence) => Promise<T>
  ): Promise<T> {
    const lock = `${this.index(config)}:lock:${kind}`
    for (let round = 0; round < LOCK_ROUNDS; round++) {
      const token = randomUUID()
      for (let attempt = 0; (await this.redis.set(lock, token, 'PX', LOCK_MS, 'NX')) !== 'OK'; attempt++) {
        if (attempt >= LOCK_TRIES) throw new Error(BUSY)
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS))
      }
      try {
        return await run({ lock, token })
      } catch (error) {
        if (!(error instanceof LockLost)) throw error
      } finally {
        await this.redis.eval(RELEASE_LOCK, 1, lock, token)
      }
    }
    throw new Error(BUSY)
  }

  async remove(
    config: ConnectRequest,
    kind: SavedItemKind,
    id: string,
    when?: (current: SavedItem) => boolean
  ): Promise<SavedItem[]> {
    // Under the same lock as `update`, so `when` judges the row that is deleted, not one an update has replaced since.
    return this.withLock(config, kind, async (fence) => {
      // Scoped to the caller's own index and kind, so an id of another account — or of a bookmark, when deleting a
      // template — matches nothing.
      const current = (await this.list(config, kind)).find((item) => item.id === id)
      if (current && (when === undefined || when(current))) await this.fenced(fence, config, [id])
      return this.list(config, kind)
    })
  }
}

const LOCK_MS = 5000
const LOCK_WAIT_MS = 15
const LOCK_TRIES = 400
/** Times a read-modify-write is run again after its lock ran out under it, before giving up as busy. */
const LOCK_ROUNDS = 3
const BUSY = 'The stored items are busy: try again'
/** The lock a `withLock` call holds: its key, and the value only that call set. */
interface Fence {
  lock: string
  token: string
}
/** A write refused because the lock is no longer the writer's (see `fenced`). */
class LockLost extends Error {}
/**
 * Stores and drops saved items only while KEYS[1], the lock, still holds ARGV[1], the writer's token. KEYS[2] is the
 * index; KEYS[3..] the items, each with its id at the ARGV index one above. With ARGV[2] (the time) not empty, the
 * first item is stored with ARGV[3] as its value and indexed; every other one is dropped.
 */
const FENCED_WRITE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local first = 3
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[3], ARGV[3])
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
  first = 4
end
for i = first, #KEYS do
  redis.call('ZREM', KEYS[2], ARGV[i + 1])
  redis.call('DEL', KEYS[i])
end
return 1
`
/**
 * Drops a stored item that would not open, only while its value is still what was read (ARGV[2], empty for a
 * missing one): KEYS[1] the index, KEYS[2] the item; ARGV[1] its id.
 */
const PRUNE_IF_UNCHANGED = `
local current = redis.call('GET', KEYS[2])
if (current or '') ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1
`
/** Deletes the lock only if it is still ours (it may have expired and been taken by someone else). */
const RELEASE_LOCK = `
  if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
  return 0
`

/** Writes the value only when what is stored still hashes to the version the caller read. */
const SET_IF_UNCHANGED = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if redis.sha1hex(current):sub(1, 32) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

const DEL_IF_UNCHANGED = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if redis.sha1hex(current):sub(1, 32) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`

/**
 * The second factor of a database account, one key per account. Kept apart from the saved items for the same
 * reason the file store keeps it in its own table: those are capped and pruned, and this must not be.
 */
class RedisSecondFactors implements SecondFactors {
  constructor(
    private readonly redis: Redis,
    private readonly key: Buffer,
    private readonly prefix: string
  ) {}

  private entry(config: ConnectRequest): string {
    return `${this.prefix}:2fa:${identityHash(this.key, config)}`
  }

  async get(config: ConnectRequest): Promise<SecondFactor | null> {
    const payload = await this.redis.getBuffer(this.entry(config))
    if (!payload) return null
    try {
      const factor = JSON.parse(open(this.key, payload, rowAad(SECOND_FACTOR, identityHash(this.key, config))))
      return { ...factor, version: version(payload) }
    } catch {
      // Will not open (a different secret, a hand-written value): dropped, so the account can enrol again
      // rather than be locked out by something nothing can read.
      await this.redis.del(this.entry(config))
      return null
    }
  }

  async set(config: ConnectRequest, factor: SecondFactor): Promise<boolean> {
    const aad = rowAad(SECOND_FACTOR, identityHash(this.key, config))
    const { version: expected, ...stored } = factor
    const payload = seal(this.key, JSON.stringify(stored), aad)
    if (expected === undefined) {
      await this.redis.set(this.entry(config), payload)
      return true
    }
    // Two requests carrying the same code reach here together: the write lands only for the one whose read is
    // still what is stored, so the other is told its code went unused rather than both being accepted.
    const applied = await this.redis.eval(SET_IF_UNCHANGED, 1, this.entry(config), expected, payload)
    return applied === 1
  }

  async create(config: ConnectRequest, factor: SecondFactor): Promise<boolean> {
    const { version: _none, ...stored } = factor
    const payload = seal(this.key, JSON.stringify(stored), rowAad(SECOND_FACTOR, identityHash(this.key, config)))
    // NX: only while the key is absent, so two first enrolments at once on two replicas do not both land.
    return (await this.redis.set(this.entry(config), payload, 'NX')) === 'OK'
  }

  async clear(config: ConnectRequest, expected?: string): Promise<boolean> {
    if (expected === undefined) {
      await this.redis.del(this.entry(config))
      return true
    }
    return (await this.redis.eval(DEL_IF_UNCHANGED, 1, this.entry(config), expected)) === 1
  }
}
