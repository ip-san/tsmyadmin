import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConnectRequest, SavedQuery } from '@tsmyadmin/shared'
import { open, rowAad, seal } from './crypto.ts'
import { identityHash } from './identity.ts'

/** Table name in the AAD of a saved-query payload. */
export const SAVED_QUERIES = 'saved_queries'

/** Per account, matching what the browser-side list holds. */
const SAVED_QUERY_LIMIT = 200

/**
 * Bookmarked statements kept on the server so they follow the account rather than the browser.
 *
 * The text is sealed with the same key as the stored credentials: a saved query is written by hand and
 * routinely contains row values, and a `CREATE USER … IDENTIFIED BY` typed once and bookmarked would otherwise
 * sit in the clear next to them. Rows are addressed by id, never by name, because the name is inside the sealed
 * payload — there is nothing queryable in a row but the identity it belongs to.
 */
export class SavedQueryStore {
  private readonly stmt: {
    byIdentity: import('node:sqlite').StatementSync
    insert: import('node:sqlite').StatementSync
    update: import('node:sqlite').StatementSync
    remove: import('node:sqlite').StatementSync
    oldest: import('node:sqlite').StatementSync
  }

  constructor(
    db: DatabaseSync,
    private readonly key: Buffer,
    private readonly now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_queries (
        id TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        payload BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS saved_queries_identity ON saved_queries (identity);
    `)
    this.stmt = {
      byIdentity: db.prepare('SELECT id, payload, updated_at FROM saved_queries WHERE identity = ?'),
      insert: db.prepare('INSERT INTO saved_queries (id, identity, payload, updated_at) VALUES (?, ?, ?, ?)'),
      update: db.prepare('UPDATE saved_queries SET payload = ?, updated_at = ? WHERE id = ? AND identity = ?'),
      remove: db.prepare('DELETE FROM saved_queries WHERE id = ? AND identity = ?'),
      oldest: db.prepare(
        'SELECT id FROM saved_queries WHERE identity = ? ORDER BY updated_at ASC LIMIT max(0, (SELECT COUNT(*) FROM saved_queries WHERE identity = ?) - ?)'
      ),
    }
  }

  private identity(config: ConnectRequest): string {
    return identityHash(this.key, config)
  }

  list(config: ConnectRequest): SavedQuery[] {
    const rows = this.stmt.byIdentity.all(this.identity(config)) as {
      id: string
      payload: Uint8Array
      updated_at: number
    }[]
    const out: SavedQuery[] = []
    for (const row of rows) {
      try {
        const body = JSON.parse(open(this.key, row.payload, rowAad(SAVED_QUERIES, row.id))) as {
          name: string
          sql: string
        }
        out.push({ id: row.id, name: body.name, sql: body.sql, at: row.updated_at })
      } catch {
        // A row that will not open is dead weight: it can never be listed, yet it still counts towards this
        // account's cap and nothing else would ever prune it. Dropped here, the same as an unreadable session
        // is dropped when it is read. Decryption is deterministic, so this cannot discard a row that would
        // have opened a moment later — and a row that stopped opening because the secret changed has already
        // been purged at startup.
        this.stmt.remove.run(row.id, this.identity(config))
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /** Creates or replaces by name, the way the browser-side list behaved. Returns the new list. */
  save(config: ConnectRequest, name: string, sql: string): SavedQuery[] {
    const identity = this.identity(config)
    const existing = this.list(config).find((q) => q.name === name)
    // Sealed against the row it lands in, so the id has to be decided first.
    const id = existing?.id ?? randomUUID()
    const payload = seal(this.key, JSON.stringify({ name, sql }), rowAad(SAVED_QUERIES, id))
    const at = this.now()
    if (existing) this.stmt.update.run(payload, at, id, identity)
    else this.stmt.insert.run(id, identity, payload, at)
    // Oldest first beyond the cap, so a runaway client cannot grow the file without bound.
    for (const row of this.stmt.oldest.all(identity, identity, SAVED_QUERY_LIMIT) as { id: string }[]) {
      this.stmt.remove.run(row.id, identity)
    }
    return this.list(config)
  }

  /** Deletes one of the caller's own rows; an id belonging to another account matches nothing. */
  remove(config: ConnectRequest, id: string): SavedQuery[] {
    this.stmt.remove.run(id, this.identity(config))
    return this.list(config)
  }
}
