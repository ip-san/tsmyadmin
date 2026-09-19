import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConnectRequest } from '@tsmyadmin/shared'
import { open, rowAad, seal } from './crypto.ts'
import { identityHash } from './identity.ts'
import { SAVED_ITEM_KINDS, type SavedItem, type SavedItemKind, type SavedItems } from './store.ts'

/** Table name in the AAD of a saved-item payload. The name is historical: export templates share the table. */
export const SAVED_QUERIES = 'saved_queries'

/** Per account and kind, matching what the browser-side list holds. */
export const SAVED_QUERY_LIMIT = 200

/** The rows of `mine` (one kind, newest first) to drop so that one more fits under `limit`. */
export function overCap(mine: readonly SavedItem[], limit: number): SavedItem[] {
  return mine.slice(Math.max(0, limit - 1))
}

/**
 * Named items (bookmarked statements, export templates) kept on the server so they follow the account rather
 * than the browser.
 *
 * The text is sealed with the same key as the stored credentials: a saved query is written by hand and
 * routinely contains row values, and a `CREATE USER … IDENTIFIED BY` typed once and bookmarked would otherwise
 * sit in the clear next to them. Rows are addressed by id, never by name, because the name is inside the sealed
 * payload — there is nothing queryable in a row but the identity it belongs to, which is also why the kind lives
 * in the payload and is filtered after opening it rather than in SQL.
 */
export class SqliteSavedQueries implements SavedItems {
  private readonly stmt: {
    byIdentity: import('node:sqlite').StatementSync
    insert: import('node:sqlite').StatementSync
    update: import('node:sqlite').StatementSync
    remove: import('node:sqlite').StatementSync
  }

  private readonly db: DatabaseSync

  constructor(
    db: DatabaseSync,
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
    private readonly limit = SAVED_QUERY_LIMIT
  ) {
    this.db = db
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
    }
  }

  private identity(config: ConnectRequest): string {
    return identityHash(this.key, config)
  }

  async list(config: ConnectRequest, kind: SavedItemKind): Promise<SavedItem[]> {
    const rows = this.stmt.byIdentity.all(this.identity(config)) as {
      id: string
      payload: Uint8Array
      updated_at: number
    }[]
    const out: SavedItem[] = []
    for (const row of rows) {
      try {
        const item = readPayload(open(this.key, row.payload, rowAad(SAVED_QUERIES, row.id)), row.id, row.updated_at)
        if (item.kind === kind) out.push(item)
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

  /** Creates or replaces by name within the kind, the way the browser-side list behaved. Returns the new list. */
  async save(
    config: ConnectRequest,
    kind: SavedItemKind,
    name: string,
    body: string,
    replaces?: string
  ): Promise<SavedItem[]> {
    const identity = this.identity(config)
    const mine = await this.list(config, kind)
    const existing = mine.find((q) => q.name === name)
    // Never the row being written: replacing a row with itself would delete what this call just stored.
    const replaced = replaces === undefined ? undefined : mine.find((q) => q.id === replaces && q.id !== existing?.id)
    // Sealed against the row it lands in, so the id has to be decided first.
    const id = existing?.id ?? randomUUID()
    const payload = seal(this.key, JSON.stringify({ kind, name, body }), rowAad(SAVED_QUERIES, id))
    const at = this.now()
    // One transaction: the row being replaced goes in the same write as the new one, so a failure leaves the
    // account exactly as it was and the cap never sees the two of them at once.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (replaced) this.stmt.remove.run(replaced.id, identity)
      if (existing) this.stmt.update.run(payload, at, id, identity)
      else {
        // Oldest of this kind first beyond its cap, so a runaway client cannot grow the file without bound. The
        // kind is inside the sealed payload, which is why this works from the opened list rather than in SQL.
        const others = mine.filter((q) => q.id !== replaced?.id)
        for (const victim of overCap(others, this.limit)) this.stmt.remove.run(victim.id, identity)
        this.stmt.insert.run(id, identity, payload, at)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.list(config, kind)
  }

  /** Deletes one of the caller's own rows of that kind; any other id matches nothing. */
  async remove(config: ConnectRequest, kind: SavedItemKind, id: string): Promise<SavedItem[]> {
    const mine = await this.list(config, kind)
    if (mine.some((item) => item.id === id)) this.stmt.remove.run(id, this.identity(config))
    return this.list(config, kind)
  }
}

/**
 * A sealed payload as an item. Rows written before export templates existed hold `{ name, sql }` and no kind:
 * they are bookmarks, and are read as such rather than being thrown away (as is a kind this version does not know).
 */
export function readPayload(json: string, id: string, at: number): SavedItem {
  const body = JSON.parse(json) as { kind?: string; name: string; sql?: string; body?: string }
  const kind: SavedItemKind = SAVED_ITEM_KINDS.find((k) => k === body.kind) ?? 'sql'
  return { id, kind, name: body.name, body: body.body ?? body.sql ?? '', at }
}
