import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { countStatements } from '@tsmyadmin/adapter'
import type {
  ConnectRequest,
  Namespace,
  Snapshot,
  SnapshotRestorePreview,
  SnapshotRestoreResult,
  TableInfo,
} from '@tsmyadmin/shared'
import { ExportQuerySchema } from '@tsmyadmin/shared'
import { startSweep } from '../session/store.ts'
import { buildExport, DUMP_COMPLETE_MARKER } from './export.ts'
import { importSql } from './import.ts'

/** What one database keeps, what one dump may weigh, and what all of them together may hold in memory. */
export const SNAPSHOT_MAX_COUNT = 10
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
const SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024
/** How long one is kept after it was taken: long enough to try a migration and go back, short enough not to pile up. */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60_000
/** How often what has outlived that is let go even when nobody asks for a snapshot. */
const SWEEP_INTERVAL_MS = 10 * 60_000

/** Held and being-taken together would pass the total: what to do about it differs from a dump that is too large. */
function fullError(): SnapshotError {
  return new SnapshotError(
    'FULL',
    'The snapshots held in memory, and the ones being taken, would pass their total limit: remove some, or try again shortly'
  )
}

export class SnapshotError extends Error {
  constructor(
    readonly reason: 'TOO_MANY' | 'TOO_LARGE' | 'INCOMPLETE' | 'FULL',
    message: string
  ) {
    super(message)
  }
}

interface Held {
  snapshot: Snapshot
  /** The dump: structure, data, routines, with the DROP … IF EXISTS that lets it run over what is there. */
  sql: string
  statements: number
  /** Tables and views the database had when it was taken. */
  names: ReadonlySet<string>
}

/**
 * The snapshots of this process, in memory (they go when it restarts). Kept per account and database: an account
 * sees and restores only what it took itself, so a dump of rows it could not read never reaches another login.
 */
export class SnapshotStore {
  private readonly held = new Map<string, Held[]>()
  private nextId = 1
  /** What the snapshots being taken right now may still add: counted with what is held, from the moment they start. */
  private reserved = 0
  private readonly totalLimit: number
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly onExpire: ((count: number) => void) | undefined

  /**
   * The total they may fill, how long one is kept, a clock, and who is told when some were let go (the count only).
   * A snapshot is dropped once it is older than the time to live, checked before every operation; the timer only
   * gives the memory back when nobody is asking, and never keeps the process alive.
   */
  constructor(
    options: {
      totalLimit?: number
      ttlMs?: number
      now?: () => number
      sweepIntervalMs?: number
      onExpire?: (count: number) => void
    } = {}
  ) {
    this.totalLimit = options.totalLimit ?? SNAPSHOT_TOTAL_BYTES
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS
    this.now = options.now ?? Date.now
    this.onExpire = options.onExpire
    startSweep(options.sweepIntervalMs ?? SWEEP_INTERVAL_MS, () => this.expire())
  }

  /** Lets go of every snapshot older than the time to live; an account's list never shows one that has expired. */
  private expire(): void {
    const oldest = this.now() - this.ttlMs
    let gone = 0
    for (const [scope, list] of this.held) {
      const kept = list.filter((h) => Date.parse(h.snapshot.at) > oldest)
      if (kept.length === list.length) continue
      gone += list.length - kept.length
      if (kept.length === 0) this.held.delete(scope)
      else this.held.set(scope, kept)
    }
    if (gone > 0) this.onExpire?.(gone)
  }

  /** Who took it, on which server, of which database (and PostgreSQL schema). */
  static scope(config: Pick<ConnectRequest, 'host' | 'port' | 'user'>, ns: Namespace): string {
    return JSON.stringify([config.user, config.host, config.port, ns.database, ns.schema ?? ''])
  }

  list(scope: string): Snapshot[] {
    this.expire()
    return (this.held.get(scope) ?? []).map((h) => h.snapshot)
  }

  get(scope: string, id: string): Held | undefined {
    this.expire()
    return this.held.get(scope)?.find((h) => h.snapshot.id === id)
  }

  private totalBytes(): number {
    let total = this.reserved
    for (const list of this.held.values()) for (const h of list) total += h.snapshot.bytes
    return total
  }

  /**
   * Sets aside the room a snapshot about to be read may fill — `most`, or what is left of the total if that is less —
   * so the dumps being taken count against the limit as soon as they start, not only once they are held (taken at
   * once, they could otherwise add up to many times it). A small database still fits when the store is nearly full:
   * only a dump that outgrows the room is refused. Returns that room and the release, to call when the dump is
   * stored or given up; calling it twice does nothing.
   */
  reserve(most: number): { limit: number; release: () => void } {
    this.expire()
    const limit = Math.min(most, this.totalLimit - this.totalBytes())
    if (limit <= 0) throw fullError()
    this.reserved += limit
    let released = false
    return {
      limit,
      release: () => {
        if (released) return
        released = true
        this.reserved -= limit
      },
    }
  }

  add(scope: string, held: Omit<Held, 'snapshot'>, name: string, at: Date): Snapshot {
    this.expire()
    const list = this.held.get(scope) ?? []
    if (list.length >= SNAPSHOT_MAX_COUNT)
      throw new SnapshotError('TOO_MANY', `A database keeps at most ${SNAPSHOT_MAX_COUNT} snapshots: remove one first`)
    const bytes = Buffer.byteLength(held.sql)
    if (this.totalBytes() + bytes > this.totalLimit) throw fullError()
    const snapshot: Snapshot = {
      id: String(this.nextId++),
      name,
      at: at.toISOString(),
      bytes,
      objects: held.names.size,
    }
    this.held.set(scope, [...list, { ...held, snapshot }])
    return snapshot
  }

  remove(scope: string, id: string): boolean {
    this.expire()
    const list = this.held.get(scope) ?? []
    const rest = list.filter((h) => h.snapshot.id !== id)
    if (rest.length === list.length) return false
    if (rest.length === 0) this.held.delete(scope)
    else this.held.set(scope, rest)
    return true
  }
}

/**
 * A dump read to the end, refused past the limit (a snapshot is memory: a big database is an export's job). The limit
 * is in bytes, as the screen says: counting characters would let text in a wide script through at up to three times it.
 */
async function readDump(
  body: AsyncIterable<string | Uint8Array>,
  maxBytes: number,
  tooLarge: () => SnapshotError
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for await (const chunk of body) {
    if (typeof chunk === 'string') {
      text += chunk
      bytes += Buffer.byteLength(chunk)
    } else {
      text += decoder.decode(chunk, { stream: true })
      bytes += chunk.byteLength
    }
    if (bytes > maxBytes) throw tooLarge()
  }
  return text
}

/** Tables first, so a view in the dump follows what it reads (the order the Export screen uses). */
const tableNames = (all: readonly TableInfo[]) =>
  [...all.filter((t) => t.kind === 'table'), ...all.filter((t) => t.kind !== 'table')].map((t) => t.name)

/** Takes a snapshot: the whole namespace as an SQL dump that restores over what is there. */
export async function takeSnapshot(
  store: SnapshotStore,
  scope: string,
  adapter: DatabaseAdapter,
  ns: Namespace,
  name: string,
  now: Date = new Date(),
  maxBytes: number = SNAPSHOT_MAX_BYTES
): Promise<Snapshot> {
  // First of all, before anything is awaited: what this one may weigh is counted from the moment it starts.
  const { limit, release } = store.reserve(maxBytes)
  try {
    const all = await adapter.listTables(ns)
    const q = ExportQuerySchema.parse({ format: 'sql' })
    const file = buildExport(adapter, ns, tableNames(all), q, ns.database, true, all)
    // Past the room that was left rather than past the dump limit: the same dump would fit once something is removed.
    const tooLarge = () =>
      limit < maxBytes
        ? fullError()
        : new SnapshotError(
            'TOO_LARGE',
            `The dump is larger than ${maxBytes / 1024 / 1024} MB: a database this size is for Export`
          )
    const sql = await readDump(file.body, limit, tooLarge)
    if (!sql.includes(DUMP_COMPLETE_MARKER))
      throw new SnapshotError('INCOMPLETE', 'The dump did not finish: nothing was saved')
    // Counted, not split: the array of a big dump's statements weighs several times the dump itself.
    const statements = countStatements(sql, adapter.dialect)
    // Given back just before it is stored, with nothing awaited between: held and reserved never count it twice.
    release()
    return store.add(scope, { sql, statements, names: new Set(all.map((t) => t.name)) }, name, now)
  } finally {
    release()
  }
}

/** The statements that remove what the database has now and the snapshot did not (made since). */
async function extraDrops(adapter: DatabaseAdapter, ns: Namespace, names: ReadonlySet<string>): Promise<string[]> {
  const extra = (await adapter.listTables(ns)).filter((t) => !names.has(t.name))
  if (extra.length === 0) return []
  return adapter.ddl.build(ns, { op: 'dropObjects', objects: extra.map((t) => ({ name: t.name, kind: t.kind })) })
}

export async function previewRestore(
  adapter: DatabaseAdapter,
  ns: Namespace,
  held: Held
): Promise<SnapshotRestorePreview> {
  return {
    snapshot: held.snapshot,
    statements: held.statements,
    drops: await extraDrops(adapter, ns, held.names),
  }
}

/**
 * Puts the snapshot back: what was made since is dropped, then the dump runs over the rest. PostgreSQL does it in
 * one transaction (a failure leaves the database as it was); MySQL cannot roll back DDL, so it turns foreign key
 * checks off for the run and a failure leaves what had already run.
 */
export async function restoreSnapshot(
  adapter: DatabaseAdapter,
  ns: Namespace,
  held: Held,
  queryId: string
): Promise<SnapshotRestoreResult> {
  const drops = await extraDrops(adapter, ns, held.names)
  const script = `${drops.map((d) => `${d};\n`).join('')}${held.sql}`
  const result = await importSql(adapter, ns, script, {
    stopOnError: true,
    ignoreForeignKeys: adapter.dialect === 'mysql',
    singleTransaction: adapter.dialect === 'postgres',
    queryId,
  })
  if (result.format !== 'sql') throw new Error('A SQL restore answered with another kind of result')
  return {
    statements: result.statements,
    failed: result.failed,
    errors: result.errors.map((e) => e.message),
    durationMs: result.durationMs,
  }
}
