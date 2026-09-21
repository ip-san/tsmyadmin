import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { splitStatements } from '@tsmyadmin/adapter'
import type {
  ConnectRequest,
  Namespace,
  Snapshot,
  SnapshotRestorePreview,
  SnapshotRestoreResult,
  TableInfo,
} from '@tsmyadmin/shared'
import { ExportQuerySchema } from '@tsmyadmin/shared'
import { buildExport, DUMP_COMPLETE_MARKER } from './export.ts'
import { importSql } from './import.ts'

/** What one database keeps, what one dump may weigh, and what all of them together may hold in memory. */
export const SNAPSHOT_MAX_COUNT = 10
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
const SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024

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

  /** Who took it, on which server, of which database (and PostgreSQL schema). */
  static scope(config: Pick<ConnectRequest, 'host' | 'port' | 'user'>, ns: Namespace): string {
    return JSON.stringify([config.user, config.host, config.port, ns.database, ns.schema ?? ''])
  }

  list(scope: string): Snapshot[] {
    return (this.held.get(scope) ?? []).map((h) => h.snapshot)
  }

  get(scope: string, id: string): Held | undefined {
    return this.held.get(scope)?.find((h) => h.snapshot.id === id)
  }

  private totalBytes(): number {
    let total = 0
    for (const list of this.held.values()) for (const h of list) total += h.snapshot.bytes
    return total
  }

  add(scope: string, held: Omit<Held, 'snapshot'>, name: string, at: Date): Snapshot {
    const list = this.held.get(scope) ?? []
    if (list.length >= SNAPSHOT_MAX_COUNT)
      throw new SnapshotError('TOO_MANY', `A database keeps at most ${SNAPSHOT_MAX_COUNT} snapshots: remove one first`)
    const bytes = Buffer.byteLength(held.sql)
    if (this.totalBytes() + bytes > SNAPSHOT_TOTAL_BYTES)
      throw new SnapshotError('FULL', 'The snapshots held in memory would pass their total limit: remove some first')
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
    const list = this.held.get(scope) ?? []
    const rest = list.filter((h) => h.snapshot.id !== id)
    if (rest.length === list.length) return false
    if (rest.length === 0) this.held.delete(scope)
    else this.held.set(scope, rest)
    return true
  }
}

/** A dump read to the end, refused past the limit (a snapshot is memory: a big database is an export's job). */
async function readDump(body: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of body) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    if (text.length > SNAPSHOT_MAX_BYTES)
      throw new SnapshotError(
        'TOO_LARGE',
        `The dump is larger than ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MB: a database this size is for Export`
      )
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
  now: Date = new Date()
): Promise<Snapshot> {
  const all = await adapter.listTables(ns)
  const q = ExportQuerySchema.parse({ format: 'sql' })
  const file = buildExport(adapter, ns, tableNames(all), q, ns.database, true, all)
  const sql = await readDump(file.body)
  if (!sql.includes(DUMP_COMPLETE_MARKER))
    throw new SnapshotError('INCOMPLETE', 'The dump did not finish: nothing was saved')
  const statements = splitStatements(sql, adapter.dialect).length
  return store.add(scope, { sql, statements, names: new Set(all.map((t) => t.name)) }, name, now)
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
