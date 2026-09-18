import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ConnectRequest } from '@tsmyadmin/shared'
import { open, rowAad, seal } from './crypto.ts'
import { identityHash } from './identity.ts'
import type { SecondFactor, SecondFactors } from './store.ts'

/** Table name in the AAD of a second-factor payload. */
export const SECOND_FACTOR = 'second_factor'

/**
 * The second factor of a database account: one row per account, sealed with the same key as the stored
 * credentials.
 *
 * Deliberately not part of the saved-items table: those are capped per account and pruned oldest first, so an
 * account with two hundred bookmarks would eventually evict the very thing that lets it log in.
 */
export class SqliteSecondFactors implements SecondFactors {
  private readonly stmt: {
    get: StatementSync
    put: StatementSync
    remove: StatementSync
  }

  constructor(
    db: DatabaseSync,
    private readonly key: Buffer
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS second_factor (
        identity TEXT PRIMARY KEY,
        payload BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.stmt = {
      get: db.prepare('SELECT payload FROM second_factor WHERE identity = ?'),
      put: db.prepare('INSERT OR REPLACE INTO second_factor (identity, payload, updated_at) VALUES (?, ?, ?)'),
      remove: db.prepare('DELETE FROM second_factor WHERE identity = ?'),
    }
  }

  private identity(config: ConnectRequest): string {
    return identityHash(this.key, config)
  }

  async get(config: ConnectRequest): Promise<SecondFactor | null> {
    const identity = this.identity(config)
    const row = this.stmt.get.get(identity) as { payload: Uint8Array } | undefined
    if (!row) return null
    try {
      return JSON.parse(open(this.key, row.payload, rowAad(SECOND_FACTOR, identity))) as SecondFactor
    } catch {
      // Unreadable (a hand-edited file): dropped, so the account can enrol again rather than being locked out
      // by a row nothing can open. A rotated secret is purged at startup, before this can be reached.
      this.stmt.remove.run(identity)
      return null
    }
  }

  async set(config: ConnectRequest, factor: SecondFactor): Promise<void> {
    const identity = this.identity(config)
    this.stmt.put.run(identity, seal(this.key, JSON.stringify(factor), rowAad(SECOND_FACTOR, identity)), factor.at)
  }

  async clear(config: ConnectRequest): Promise<void> {
    this.stmt.remove.run(this.identity(config))
  }
}
