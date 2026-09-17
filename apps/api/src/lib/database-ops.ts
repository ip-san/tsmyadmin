import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { type DdlOp, isGeneratedColumn, type Namespace, SYSTEM_DATABASES } from '@tsmyadmin/shared'

export type DatabaseOp = Extract<DdlOp, { op: 'renameDatabase' | 'copyDatabase' }>

/** A rename or copy the preview will not build, with the API error it maps to. */
export class DatabaseOpRefused extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'NOT_FOUND',
    message: string
  ) {
    super(message)
  }
}

/**
 * Checks a rename or copy of a whole database and fills in what only the server can know.
 *
 * `tables` and `collation` are always replaced, never taken from the request, so a stale page or a hand-written
 * request cannot move a partial set. (A MySQL rename does not drop the old database, so nothing left off is lost.)
 */
export async function prepareDatabaseOp(
  adapter: DatabaseAdapter,
  connected: Namespace,
  op: DatabaseOp
): Promise<DatabaseOp> {
  const { dialect } = adapter
  if (op.name === op.newName) throw new DatabaseOpRefused('VALIDATION', 'The new name is the same as the current one')
  if (SYSTEM_DATABASES[dialect].has(op.name.toLowerCase()))
    throw new DatabaseOpRefused('VALIDATION', `"${op.name}" is one of the server's own databases`)
  const databases = await adapter.listDatabases()
  const source = databases.find((d) => d.name === op.name)
  if (!source) throw new DatabaseOpRefused('NOT_FOUND', `Unknown database: ${op.name}`)
  const existing = databases.find((d) => d.name === op.newName)
  if (existing)
    throw new DatabaseOpRefused(
      'VALIDATION',
      // Not "empty": the count only covers tables this account can see. A database a MySQL rename left behind is
      // in exactly this state, and may still hold routines or events the account cannot list.
      existing.tableCount === 0
        ? `A database named "${op.newName}" already exists (it has no tables visible to this account)`
        : `A database named "${op.newName}" already exists`
    )

  if (dialect === 'postgres') {
    // Both statements run on the connection's own database, and PostgreSQL cannot rename or copy that one.
    if (op.name === connected.database)
      throw new DatabaseOpRefused(
        'VALIDATION',
        `"${op.name}" is the database this session is connected through; sign in to another database to change it`
      )
    return op
  }

  const ns = { database: op.name }
  const objects = await adapter.listTables(ns)
  const baseTables = objects.filter((t) => t.kind === 'table').map((t) => t.name)
  const collation = source.collation ?? undefined

  if (op.op === 'renameDatabase') {
    // MySQL moves only tables. Views and routines would stay behind in the old database — views still pointing at
    // tables that have moved — and a table with a trigger cannot be moved at all, so such a database is refused.
    // This is not what keeps data safe (the old database is never dropped, and objects the account cannot see are
    // not listed here); it keeps a rename from quietly leaving a half-working database behind.
    const [triggers, routines, events] = await Promise.all([
      adapter.listTriggers(ns),
      adapter.listRoutines(ns),
      adapter.listEvents(ns),
    ])
    const count = (kinds: string[]) => objects.filter((t) => kinds.includes(t.kind)).length
    const blockers = [
      [count(['view', 'materialized_view']), 'views'],
      // MariaDB sequences: listed alongside tables, but not moved by RENAME TABLE here.
      [count(['sequence']), 'sequences'],
      [triggers.length, 'triggers'],
      [routines.length, 'routines'],
      [events.length, 'events'],
    ].filter(([n]) => (n as number) > 0)
    if (blockers.length > 0)
      throw new DatabaseOpRefused(
        'VALIDATION',
        `"${op.name}" cannot be renamed while it has ${blockers.map(([n, what]) => `${n} ${what}`).join(', ')}: MySQL renames a database by moving its tables, and these would be left behind`
      )
    return { ...op, tables: baseTables, ...(collation ? { collation } : { collation: undefined }) }
  }

  const tables = await Promise.all(
    baseTables.map(async (name) => ({
      name,
      columns: (await adapter.describeTable(ns, name)).columns
        .filter((c) => !isGeneratedColumn(c.extra))
        .map((c) => c.name),
    }))
  )
  return { ...op, tables, ...(collation ? { collation } : { collation: undefined }) }
}
