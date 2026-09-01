import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema } from '@tsmyadmin/shared'
import { deriveSessionKey, open, seal } from './crypto.ts'
import {
  type AdapterFactory,
  connectAdapter,
  SESSION_TTL_MS,
  type Session,
  type SessionStore,
  startSweep,
} from './store.ts'

export interface SqliteSessionStoreOptions {
  /** File path, or ':memory:' for tests. Parent directories are created. */
  path: string
  /** Session secret; the at-rest key is derived from it (rotating it invalidates stored sessions). */
  secret: string
  adapterFactory: AdapterFactory
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

/** Process-local part of a session: the decrypted config (validated once) and the live adapter. */
interface Live {
  config: ConnectRequest
  adapter: DatabaseAdapter
  createdAt: number
  lastTouch: number
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
  private readonly factory: AdapterFactory
  private readonly live = new Map<string, Live>()
  private timer: ReturnType<typeof setInterval> | null
  private readonly stmt: {
    insert: StatementSync
    select: StatementSync
    touch: StatementSync
    remove: StatementSync
    stale: StatementSync
    count: StatementSync
  }

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
    this.stmt = {
      insert: this.db.prepare('INSERT INTO sessions (id, payload, created_at, last_used_at) VALUES (?, ?, ?, ?)'),
      select: this.db.prepare('SELECT id, payload, created_at, last_used_at FROM sessions WHERE id = ?'),
      touch: this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?'),
      remove: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      stale: this.db.prepare('SELECT id FROM sessions WHERE last_used_at < ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM sessions'),
    }
    this.key = deriveSessionKey(options.secret)
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? Date.now
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000
    this.factory = options.adapterFactory
    this.timer = startSweep(options.sweepIntervalMs ?? 60_000, () => void this.sweep())
  }

  get size(): number {
    return (this.stmt.count.get() as { n: number }).n
  }

  async create(config: ConnectRequest): Promise<Session> {
    const adapter = await connectAdapter(this.factory, config)
    const id = crypto.randomUUID()
    const now = this.now()
    this.stmt.insert.run(id, seal(this.key, JSON.stringify(config)), now, now)
    this.live.set(id, { config, adapter, createdAt: now, lastTouch: now })
    return { id, config, adapter, createdAt: now, lastUsedAt: now }
  }

  async get(id: string): Promise<Session | undefined> {
    const row = this.stmt.select.get(id) as Row | undefined
    if (!row) return undefined
    const now = this.now()
    if (now - row.last_used_at > this.ttlMs) {
      await this.delete(id)
      return undefined
    }
    let live = this.live.get(id)
    if (!live) {
      // First use after a restart: decrypt + validate once, then keep the config with the rebuilt pool.
      let config: ConnectRequest
      try {
        config = ConnectRequestSchema.parse(JSON.parse(open(this.key, row.payload)))
      } catch {
        // Undecryptable (secret rotated) or corrupt: drop it rather than fail every request.
        await this.delete(id)
        return undefined
      }
      live = { config, adapter: this.factory(config), createdAt: row.created_at, lastTouch: row.last_used_at }
      this.live.set(id, live)
    }
    if (now - live.lastTouch >= this.touchIntervalMs) {
      this.stmt.touch.run(now, id)
      live.lastTouch = now
    }
    return { id, config: live.config, adapter: live.adapter, createdAt: live.createdAt, lastUsedAt: now }
  }

  async delete(id: string): Promise<void> {
    this.stmt.remove.run(id)
    await this.closeLive(id)
  }

  async ping(): Promise<void> {
    this.stmt.count.get()
  }

  async sweep(): Promise<void> {
    const stale = this.stmt.stale.all(this.now() - this.ttlMs) as { id: string }[]
    for (const { id } of stale) await this.delete(id)
  }

  /** Closes this process's pools; rows stay so the next process can resume the sessions. */
  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.live.keys()]) await this.closeLive(id)
    this.db.close()
  }

  private async closeLive(id: string): Promise<void> {
    const live = this.live.get(id)
    this.live.delete(id)
    if (live) await live.adapter.close().catch(() => undefined)
  }
}
