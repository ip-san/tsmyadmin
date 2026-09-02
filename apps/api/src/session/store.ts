import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ConnectRequest, SessionInfo } from '@tsmyadmin/shared'

export interface Session {
  readonly id: string
  readonly config: ConnectRequest
  readonly adapter: DatabaseAdapter
  readonly createdAt: number
  lastUsedAt: number
}

/** Builds the (already audited) adapter for a connection; owned by the session store. */
export type AdapterFactory = (config: ConnectRequest) => DatabaseAdapter

/**
 * Session persistence. The interface is async so process-external stores (SQLite / Redis) can implement it.
 * Adapters (connection pools) are always process-local: the store builds them through its single factory,
 * both on login and when resuming a session after a restart.
 */
export interface SessionStore {
  /** Builds the adapter, verifies the connection (ping) and persists the session. Throws when the DB rejects. */
  create(config: ConnectRequest): Promise<Session>
  /** Returns the session and refreshes its TTL. */
  get(id: string): Promise<Session | undefined>
  delete(id: string): Promise<void>
  /** Liveness of the backing store (used by /readyz). */
  ping(): Promise<void>
  /** Closes every adapter (shutdown / tests). */
  closeAll(): Promise<void>
}

/** Everything about a connection except the password (what logs, audit lines and the client may see). */
export function sessionIdentity(config: ConnectRequest): SessionInfo {
  const { password: _password, ...info } = config
  return info
}

export function sessionInfo(session: Session): SessionInfo {
  return sessionIdentity(session.config)
}

export const SESSION_TTL_MS = 30 * 60 * 1000
/** Live sessions allowed per database identity (dialect|host|port|user); the oldest is evicted beyond this. */
export const DEFAULT_MAX_SESSIONS_PER_IDENTITY = 10

/**
 * Groups sessions that hold pools against the same account. Bounding this keeps one account holder from
 * exhausting the database's max_connections by logging in repeatedly (each session pings and pools connections).
 */
export function identityKey(config: ConnectRequest): string {
  return `${config.dialect}|${config.host.toLowerCase()}|${config.port}|${config.user}`
}

/** Interval timer that never keeps the process alive; null when disabled. */
export function startSweep(intervalMs: number, fn: () => void): ReturnType<typeof setInterval> | null {
  if (intervalMs <= 0) return null
  const timer = setInterval(fn, intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return timer
}

/** Builds an adapter and proves the credentials work; a failed ping never leaks a pool. */
export async function connectAdapter(factory: AdapterFactory, config: ConnectRequest): Promise<DatabaseAdapter> {
  const adapter = factory(config)
  try {
    await adapter.ping()
  } catch (err) {
    await adapter.close().catch(() => undefined)
    throw err
  }
  return adapter
}

export interface MemorySessionStoreOptions {
  adapterFactory: AdapterFactory
  ttlMs?: number
  maxPerIdentity?: number
  sweepIntervalMs?: number
  now?: () => number
}

/**
 * In-memory store with sliding TTL. Sessions are lost on restart (use the SQLite store in production).
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly factory: AdapterFactory
  private readonly ttlMs: number
  private readonly maxPerIdentity: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null

  constructor(options: MemorySessionStoreOptions) {
    this.factory = options.adapterFactory
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.maxPerIdentity = options.maxPerIdentity ?? DEFAULT_MAX_SESSIONS_PER_IDENTITY
    this.now = options.now ?? Date.now
    this.timer = startSweep(options.sweepIntervalMs ?? 60_000, () => void this.sweep())
  }

  get size(): number {
    return this.sessions.size
  }

  async create(config: ConnectRequest): Promise<Session> {
    const adapter = await connectAdapter(this.factory, config)
    // Evict the least recently used sessions of the same account beyond the cap (after a successful connect,
    // so a wrong password cannot be used to log other people out).
    const identity = identityKey(config)
    const same = [...this.sessions.values()]
      .filter((s) => identityKey(s.config) === identity)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const victim of same.slice(0, Math.max(0, same.length - this.maxPerIdentity + 1))) await this.delete(victim.id)
    const id = crypto.randomUUID()
    const now = this.now()
    const session: Session = { id, config, adapter, createdAt: now, lastUsedAt: now }
    this.sessions.set(id, session)
    return session
  }

  async get(id: string): Promise<Session | undefined> {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (this.now() - s.lastUsedAt > this.ttlMs) {
      await this.delete(id)
      return undefined
    }
    s.lastUsedAt = this.now()
    return s
  }

  async delete(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    await s.adapter.close().catch(() => undefined)
  }

  async ping(): Promise<void> {
    // Nothing external to check.
  }

  async sweep(): Promise<void> {
    const cutoff = this.now() - this.ttlMs
    for (const [id, s] of this.sessions) if (s.lastUsedAt < cutoff) await this.delete(id)
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.sessions.keys()]) await this.delete(id)
  }
}
