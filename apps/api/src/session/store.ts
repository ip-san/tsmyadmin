import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ConnectRequest, SessionInfo } from '@tsmyadmin/shared'

export interface Session {
  readonly id: string
  readonly config: ConnectRequest
  readonly adapter: DatabaseAdapter
  readonly createdAt: number
  lastUsedAt: number
}

export interface SessionStore {
  create(config: ConnectRequest, adapter: DatabaseAdapter): Session
  /** Returns the session and refreshes its TTL. */
  get(id: string): Session | undefined
  delete(id: string): Promise<void>
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
 * sessions are lost on restart (accepted for now — see plan: Redis/SQLite later).
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMs: number
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

  private readonly now: () => number

  get size(): number {
    return this.sessions.size
  }

  create(config: ConnectRequest, adapter: DatabaseAdapter): Session {
    const id = crypto.randomUUID()
    const now = this.now()
    const session: Session = { id, config, adapter, createdAt: now, lastUsedAt: now }
    this.sessions.set(id, session)
    return session
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (this.now() - s.lastUsedAt > this.ttlMs) {
      void this.delete(id)
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
