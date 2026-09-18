import { createHash } from 'node:crypto'
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
      const factor = JSON.parse(open(this.key, row.payload, rowAad(SECOND_FACTOR, identity))) as SecondFactor
      return { ...factor, version: version(row.payload) }
    } catch {
      // Unreadable (a hand-edited file): dropped, so the account can enrol again rather than being locked out
      // by a row nothing can open. A rotated secret is purged at startup, before this can be reached.
      this.stmt.remove.run(identity)
      return null
    }
  }

  async set(config: ConnectRequest, factor: SecondFactor): Promise<boolean> {
    const identity = this.identity(config)
    const { version: expected, ...stored } = factor
    const payload = seal(this.key, JSON.stringify(stored), rowAad(SECOND_FACTOR, identity))
    if (expected === undefined) {
      this.stmt.put.run(identity, payload, stored.at)
      return true
    }
    // node:sqlite is synchronous, so the read and the write cannot be interleaved by another request here; the
    // comparison is what keeps the contract true for any store, and what a second process would need.
    const row = this.stmt.get.get(identity) as { payload: Uint8Array } | undefined
    if (!row || version(row.payload) !== expected) return false
    this.stmt.put.run(identity, payload, stored.at)
    return true
  }

  async clear(config: ConnectRequest, expected?: string): Promise<boolean> {
    const identity = this.identity(config)
    if (expected !== undefined) {
      // Synchronous like `set`: the read and the delete cannot be interleaved by another request here.
      const row = this.stmt.get.get(identity) as { payload: Uint8Array } | undefined
      if (!row || version(row.payload) !== expected) return false
    }
    this.stmt.remove.run(identity)
    return true
  }
}

/**
 * What was stored, as something short to compare a later write against. SHA-1 because Redis computes the same
 * value inside its own script (`redis.sha1hex`), and this is a change detector rather than a security property:
 * the value it fingerprints is already sealed.
 */
export function version(payload: Uint8Array): string {
  return createHash('sha1').update(payload).digest('hex').slice(0, 32)
}
