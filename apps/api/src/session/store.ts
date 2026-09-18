import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ConnectRequest as Config, ConnectRequest, SessionInfo } from '@tsmyadmin/shared'
import { identityKey } from './identity.ts'

/** What a stored item is: a bookmarked statement, or a saved set of export choices. */
export type SavedItemKind = 'sql' | 'export'

/** A stored item. `body` is the statement for 'sql' and JSON for 'export'; only the routes interpret it. */
export interface SavedItem {
  id: string
  kind: SavedItemKind
  name: string
  body: string
  at: number
}

/**
 * Named items kept per database account: bookmarked statements and export templates. Async like `SessionStore`:
 * SQLite answers from the same process, Redis over a socket. Every method returns the account's whole list of
 * that kind, which is what the routes hand back. The two kinds share the per-account cap and the same rows; a
 * name is unique within its kind.
 */
export interface SavedItems {
  list(config: Config, kind: SavedItemKind): Promise<SavedItem[]>
  /**
   * Creates or replaces by name, within the kind. `replaces` also drops that row of the caller's own, in the same
   * write: it is how a row stored under an older key is replaced without the account being briefly one row over
   * its cap (which would evict something else) or losing both if the write failed in between.
   */
  save(config: Config, kind: SavedItemKind, name: string, body: string, replaces?: string): Promise<SavedItem[]>
  /**
   * Deletes one of the caller's own rows of that kind; an id belonging to another account, or to the other kind,
   * matches nothing (a bookmark is not deleted by the route that deletes templates).
   */
  remove(config: Config, kind: SavedItemKind, id: string): Promise<SavedItem[]>
}

/**
 * The second factor of one database account: the TOTP secret, the last step accepted for it (so a code cannot be
 * used twice), and the hashes of the recovery codes that are still unused.
 */
/** A passkey registered as a second factor (WebAuthn), in the form the verifier needs it back. */
export interface StoredPasskey {
  /** Credential ID, base64url. */
  id: string
  /** COSE public key, base64url. */
  publicKey: string
  /** Signature counter last seen (0 for authenticators that do not keep one, such as synced passkeys). */
  counter: number
  transports?: string[]
  /** When it was registered. */
  at: number
}

export interface SecondFactor {
  /** TOTP secret, when an authenticator app is enrolled. */
  secret?: string
  /** Last TOTP step accepted (so a code is used once); -1 when none has been. */
  lastStep: number
  /** Passkeys enrolled as a second factor; at least one of these or `secret` is present. */
  passkeys?: StoredPasskey[]
  recoveryHashes: string[]
  /** When it was enrolled or last changed. */
  at: number
  /**
   * What was stored when this was read, for `set` to write against. Two logins carrying the same code would
   * otherwise both read the same `lastStep`, both check out and both be accepted — the guard that makes a code
   * usable once only holds if the write refuses a value that has changed underneath it.
   */
  version?: string
}

/** Where the second factor lives; absent on a store that cannot keep anything past a restart. */
export interface SecondFactors {
  get(config: Config): Promise<SecondFactor | null>
  /**
   * Writes it. When the value carries the `version` it was read at, the write only lands if nothing else has
   * written since; `false` says it did not, and the caller must treat the code as unused.
   */
  set(config: Config, factor: SecondFactor): Promise<boolean>
  /**
   * Removes it. Given the `version` it was read at, only if nothing has been written since (`false` if something
   * has): a method added a moment ago in another tab must not go with it.
   */
  clear(config: Config, version?: string): Promise<boolean>
}

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
  /**
   * Opens a session. `keepOthers` holds back the per-account limit for this one login: a second factor is
   * checked after the password, and a login about to be refused for a wrong code must not close the sessions
   * the account is already using. `enforceLimit` applies it once the login is accepted.
   */
  create(config: ConnectRequest, options?: { keepOthers?: boolean }): Promise<Session>
  /** Closes the least recently used sessions of this account beyond the cap, keeping `keep`. */
  enforceLimit(config: ConnectRequest, keep: string): Promise<void>
  /** Returns the session and refreshes its TTL. */
  get(id: string): Promise<Session | undefined>
  delete(id: string): Promise<void>
  /** Liveness of the backing store (used by /readyz). */
  ping(): Promise<void>
  /** Closes every adapter (shutdown / tests). */
  closeAll(): Promise<void>
  /**
   * Bookmarked statements, when the deployment has somewhere to keep them. Absent for the in-memory store,
   * where they would vanish on restart — the browser keeps its own list in that case.
   */
  /** Named items (bookmarks, export templates); absent where the store cannot keep them past a restart. */
  readonly savedQueries?: SavedItems
  /** Second factors per account; absent for the same reason, which is why requiring one needs a real store. */
  readonly secondFactor?: SecondFactors
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

  async create(config: ConnectRequest, options: { keepOthers?: boolean } = {}): Promise<Session> {
    const adapter = await connectAdapter(this.factory, config)
    const id = crypto.randomUUID()
    const now = this.now()
    const session: Session = { id, config, adapter, createdAt: now, lastUsedAt: now }
    this.sessions.set(id, session)
    // Evicted after a successful connect, so a wrong password cannot be used to log other people out — and,
    // when a second factor is still to be checked, only once that has passed.
    if (!options.keepOthers) await this.enforceLimit(config, id)
    return session
  }

  async enforceLimit(config: ConnectRequest, keep: string): Promise<void> {
    const identity = identityKey(config)
    const same = [...this.sessions.values()]
      .filter((s) => identityKey(s.config) === identity && s.id !== keep)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const victim of same.slice(0, Math.max(0, same.length - this.maxPerIdentity + 1))) await this.delete(victim.id)
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
