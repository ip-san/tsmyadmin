import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ConnectRequest, SessionInfo } from '@tsmyadmin/shared'

export interface Session {
  readonly id: string
  readonly config: ConnectRequest
  readonly adapter: DatabaseAdapter
  readonly createdAt: number
  lastUsedAt: number
}

/**
 * Session persistence. The interface is async so process-external stores (SQLite / Redis) can implement it;
 * adapters (connection pools) are always process-local and rebuilt lazily by the store.
 */
export interface SessionStore {
  create(config: ConnectRequest, adapter: DatabaseAdapter): Promise<Session>
  /** Returns the session and refreshes its TTL. */
  get(id: string): Promise<Session | undefined>
  delete(id: string): Promise<void>
  /** Liveness of the backing store (used by /readyz). */
  ping(): Promise<void>
  /** Closes every session (shutdown / tests). */
  closeAll(): Promise<void>
}

export function sessionInfo(session: Session): SessionInfo {
  const { password: _password, ...info } = session.config
  return info
}

export const SESSION_TTL_MS = 30 * 60 * 1000

/**
 * In-memory store with sliding TTL. Credentials never leave the server process;
 * sessions are lost on restart (use the SQLite store in production).
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: { ttlMs?: number; sweepIntervalMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? Date.now
    const sweep = options.sweepIntervalMs ?? 60_000
    if (sweep > 0) {
      this.timer = setInterval(() => void this.sweep(), sweep)
      if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
    }
  }

  get size(): number {
    return this.sessions.size
  }

  async create(config: ConnectRequest, adapter: DatabaseAdapter): Promise<Session> {
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
