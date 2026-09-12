import { createHmac } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type ConnectRequest, ConnectRequestSchema } from '@tsmyadmin/shared'
import { deriveSessionKey, open, openLegacy, rowAad, seal } from './crypto.ts'
import { identityHash } from './identity.ts'
import { SAVED_QUERIES, SavedQueryStore } from './saved-queries.ts'

/** Table name in the AAD of a session payload. */
const SESSIONS = 'sessions'
/**
 * Marks that every payload in the file is sealed against its own row. Absent (or anything else) means the
 * file predates that and its rows are re-sealed on open.
 */
const PAYLOAD_FORMAT = '2'

import {
  type AdapterFactory,
  connectAdapter,
  DEFAULT_MAX_SESSIONS_PER_IDENTITY,
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
  maxPerIdentity?: number
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
  readonly savedQueries: SavedQueryStore
  private timer: ReturnType<typeof setInterval> | null
  private readonly stmt: {
    insert: StatementSync
    select: StatementSync
    touch: StatementSync
    remove: StatementSync
    stale: StatementSync
    count: StatementSync
    byIdentity: StatementSync
  }
  private readonly maxPerIdentity: number
  /** True when the file held sessions sealed under a different secret; they were deleted on open. */
  readonly secretRotated: boolean

  constructor(options: SqliteSessionStoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- Waits for a lock instead of failing outright. Nothing here holds one for long (the longest is the
      -- payload migration, one transaction at startup), and a brief wait beats a container that will not start
      -- because another process happened to be mid-write. Not covered by a test: the setting is per connection,
      -- so a second connection cannot observe it, and node:sqlite is synchronous — a test holding the lock
      -- would block the thread that has to release it.
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        payload BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_last_used ON sessions (last_used_at);
    `)
    // Added after 0.1.0: an HMAC of the account identity (never the plain user/host) for the per-account cap.
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (!columns.some((c) => c.name === 'identity')) {
      this.db.exec(
        'ALTER TABLE sessions ADD COLUMN identity TEXT; CREATE INDEX IF NOT EXISTS sessions_identity ON sessions (identity)'
      )
    }
    this.stmt = {
      insert: this.db.prepare(
        'INSERT INTO sessions (id, payload, created_at, last_used_at, identity) VALUES (?, ?, ?, ?, ?)'
      ),
      select: this.db.prepare('SELECT id, payload, created_at, last_used_at FROM sessions WHERE id = ?'),
      touch: this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?'),
      remove: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      stale: this.db.prepare('SELECT id FROM sessions WHERE last_used_at < ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM sessions'),
      byIdentity: this.db.prepare('SELECT id FROM sessions WHERE identity = ? ORDER BY last_used_at ASC'),
    }
    this.maxPerIdentity = options.maxPerIdentity ?? DEFAULT_MAX_SESSIONS_PER_IDENTITY
    this.key = deriveSessionKey(options.secret)
    // Rows sealed under a previous SESSION_SECRET are unreadable and would otherwise linger (still decryptable
    // with the old secret) until the TTL sweep: a fingerprint of the key detects the rotation and purges them.
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const fingerprint = createHmac('sha256', this.key).update('tsmyadmin-session-key').digest('hex')
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'key_fingerprint'").get() as
      | { value: string }
      | undefined
    // A file from before the meta table (0.1.0) has no fingerprint: probe one row instead.
    this.secretRotated = stored === undefined ? !this.canDecryptAny() : stored.value !== fingerprint
    if (this.secretRotated) this.db.exec('DELETE FROM sessions')
    if (stored?.value !== fingerprint) {
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('key_fingerprint', ?)").run(fingerprint)
    }
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.now = options.now ?? Date.now
    // Same file and same key as the credentials: a bookmarked statement is written by hand and routinely
    // carries row values, so it is sealed exactly like them.
    this.savedQueries = new SavedQueryStore(this.db, this.key, this.now)
    // Saved queries go the same way, and must: a row is found by an HMAC of the account under this key, so after
    // a rotation no future request can name the old rows at all. Left alone they would never be listed, never
    // count towards the per-account cap, and never be pruned — they would simply accumulate across rotations.
    // (After the store, which is what creates the table; a 0.1.x file does not have it yet.) Rotating back to
    // the old secret would have made them readable again, but that is not worth an unbounded leak in the file.
    if (this.secretRotated) this.db.exec('DELETE FROM saved_queries')
    this.bindPayloadsToRows()
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000
    this.factory = options.adapterFactory
    this.timer = startSweep(options.sweepIntervalMs ?? 60_000, () => void this.sweep())
  }

  /**
   * Re-seals payloads written before they were bound to their row (see rowAad). Done in place so an upgrade
   * costs nobody their session or their saved queries, and in one transaction so a crash part-way cannot leave
   * some rows bound and the file still marked unbound — the next start would then fail to read the migrated
   * ones. A row that cannot be read at all is dropped, the same as on a secret rotation.
   */
  private bindPayloadsToRows(): void {
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'payload_format'").get() as
      | { value: string }
      | undefined
    if (stored?.value === PAYLOAD_FORMAT) return
    // Written out per table rather than interpolating a name: check:sql-safety draws no distinction between a
    // constant and a value, and it is right not to.
    const plan = [
      {
        table: SESSIONS,
        read: this.db.prepare('SELECT id, payload FROM sessions'),
        rebind: this.db.prepare('UPDATE sessions SET payload = ? WHERE id = ?'),
        drop: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      },
      {
        table: SAVED_QUERIES,
        read: this.db.prepare('SELECT id, payload FROM saved_queries'),
        rebind: this.db.prepare('UPDATE saved_queries SET payload = ? WHERE id = ?'),
        drop: this.db.prepare('DELETE FROM saved_queries WHERE id = ?'),
      },
    ]
    // The rows are read inside the transaction, not before it: BEGIN IMMEDIATE takes the write lock first, so a
    // second process (a rolling deploy still serving from the old image) cannot insert or change a row between
    // the read and the re-seal and have that write silently reverted.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const { table, read, rebind, drop } of plan) {
        for (const row of read.all() as { id: string; payload: Uint8Array }[]) {
          const aad = rowAad(table, row.id)
          try {
            rebind.run(seal(this.key, openLegacy(this.key, row.payload), aad), row.id)
          } catch {
            try {
              // Already bound — the meta row went missing, not the binding. Leave it exactly as it is.
              open(this.key, row.payload, aad)
            } catch {
              drop.run(row.id)
            }
          }
        }
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('payload_format', ?)").run(PAYLOAD_FORMAT)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** True when the sessions table is empty or its first row opens with the current key. */
  private canDecryptAny(): boolean {
    const row = this.db.prepare('SELECT id, payload FROM sessions LIMIT 1').get() as
      | { id: string; payload: Uint8Array }
      | undefined
    if (!row) return true
    // Either format counts: the question is whether the secret is still the right one, not how the row is
    // sealed. A file that lost its meta row (as 0.1.0 files have none at all) can hold either.
    for (const read of [
      () => open(this.key, row.payload, rowAad(SESSIONS, row.id)),
      () => openLegacy(this.key, row.payload),
    ]) {
      try {
        read()
        return true
      } catch {
        /* try the other format */
      }
    }
    return false
  }

  get size(): number {
    return (this.stmt.count.get() as { n: number }).n
  }

  async create(config: ConnectRequest): Promise<Session> {
    const adapter = await connectAdapter(this.factory, config)
    const identity = identityHash(this.key, config)
    const same = this.stmt.byIdentity.all(identity) as { id: string }[]
    for (const victim of same.slice(0, Math.max(0, same.length - this.maxPerIdentity + 1))) await this.delete(victim.id)
    const id = crypto.randomUUID()
    const now = this.now()
    this.stmt.insert.run(id, seal(this.key, JSON.stringify(config), rowAad(SESSIONS, id)), now, now, identity)
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
        config = ConnectRequestSchema.parse(JSON.parse(open(this.key, row.payload, rowAad(SESSIONS, id))))
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
