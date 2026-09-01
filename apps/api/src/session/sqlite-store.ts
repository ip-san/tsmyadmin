import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema } from '@tsmyadmin/shared'
import { deriveSessionKey, open, seal } from './crypto.ts'
import { SESSION_TTL_MS, type Session, type SessionStore } from './store.ts'

export interface SqliteSessionStoreOptions {
  /** File path, or ':memory:' for tests. Parent directories are created. */
  path: string
  /** Session secret; the at-rest key is derived from it (rotating it invalidates stored sessions). */
  secret: string
  /** Rebuilds an adapter for a session that was created by a previous process. */
  rebuild: (config: ConnectRequest) => DatabaseAdapter
  ttlMs?: number
  sweepIntervalMs?: number
  now?: () => number
  /** Minimum interval between last_used_at writes for the same session (limits write amplification). */
  touchIntervalMs?: number
}

interface Row {
  id: string
  payload: Uint8Array
  created_at: number
  last_used_at: number
}

/**
 * Sessions persisted in SQLite so a restart (or a rolling deploy) does not log everyone out.
 * Credentials are stored encrypted (AES-256-GCM, key derived from SESSION_SECRET); connection pools are
 * process-local and rebuilt on first use after a restart.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync
  private readonly key: Buffer
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly touchIntervalMs: number
  private readonly rebuild: SqliteSessionStoreOptions['rebuild']
  private readonly adapters = new Map<string, DatabaseAdapter>()
  private readonly lastTouch = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: SqliteSessionStoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        payload BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_last_used ON sessions (last_used_at);
    `)
    this.key = deriveSessionKey(options.secret)
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? Date.now
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000
    this.rebuild = options.rebuild
    const sweep = options.sweepIntervalMs ?? 60_000
    if (sweep > 0) {
      this.timer = setInterval(() => void this.sweep(), sweep)
      if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
    }
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    return row.n
  }

  async create(config: ConnectRequest, adapter: DatabaseAdapter): Promise<Session> {
    const id = crypto.randomUUID()
    const now = this.now()
    this.db
      .prepare('INSERT INTO sessions (id, payload, created_at, last_used_at) VALUES (?, ?, ?, ?)')
      .run(id, seal(this.key, JSON.stringify(config)), now, now)
    this.adapters.set(id, adapter)
    this.lastTouch.set(id, now)
    return { id, config, adapter, createdAt: now, lastUsedAt: now }
  }

  async get(id: string): Promise<Session | undefined> {
    const row = this.db.prepare('SELECT id, payload, created_at, last_used_at FROM sessions WHERE id = ?').get(id) as
      | Row
      | undefined
    if (!row) return undefined
    const now = this.now()
    if (now - row.last_used_at > this.ttlMs) {
      await this.delete(id)
      return undefined
    }
    let config: ConnectRequest
    try {
      config = ConnectRequestSchema.parse(JSON.parse(open(this.key, row.payload)))
    } catch {
      // Undecryptable (secret rotated) or corrupt: drop it rather than fail every request.
      await this.delete(id)
      return undefined
    }
    let adapter = this.adapters.get(id)
    if (!adapter) {
      adapter = this.rebuild(config)
      this.adapters.set(id, adapter)
    }
    if (now - (this.lastTouch.get(id) ?? 0) >= this.touchIntervalMs) {
      this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(now, id)
      this.lastTouch.set(id, now)
    }
    return { id, config, adapter, createdAt: row.created_at, lastUsedAt: now }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    this.lastTouch.delete(id)
    await this.closeAdapter(id)
  }

  async ping(): Promise<void> {
    this.db.prepare('SELECT 1').get()
  }

  async sweep(): Promise<void> {
    const cutoff = this.now() - this.ttlMs
    const stale = this.db.prepare('SELECT id FROM sessions WHERE last_used_at < ?').all(cutoff) as { id: string }[]
    for (const { id } of stale) await this.delete(id)
  }

  /** Closes this process's pools; rows stay so the next process can resume the sessions. */
  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.adapters.keys()]) await this.closeAdapter(id)
    this.db.close()
  }

  private async closeAdapter(id: string): Promise<void> {
    const adapter = this.adapters.get(id)
    this.adapters.delete(id)
    if (adapter) await adapter.close().catch(() => undefined)
  }
}
