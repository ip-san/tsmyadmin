import { type DdlOp, type FkAction, FkActionSchema, isGeneratedColumn, type Namespace } from '@tsmyadmin/shared'
import { checkDatabaseOp, type DatabaseOp } from '../sql/database-op.ts'
import { AdapterError, type DatabaseAdapter } from '../types.ts'

/**
 * Fills in what only the server can say before the SQL of an op is built, for the ops that need it. The builders are
 * pure: a copy that lists the insertable columns, a collation change that lists the tables, a whole-database rename or
 * copy that lists what moves, all read the server first. Anything else is returned as it came.
 */
export async function mysqlPrepareDdl(adapter: DatabaseAdapter, ns: Namespace, op: DdlOp): Promise<DdlOp> {
  switch (op.op) {
    case 'setDatabaseCollation': {
      if (!op.applyToTables || op.tables !== undefined) return op
      // The tables as they are now: the preview lists every statement.
      const tables = (await adapter.listTables(ns)).filter((t) => t.kind === 'table').map((t) => t.name)
      return { ...op, tables }
    }
    case 'copyTables': {
      if (!op.withData || op.details !== undefined) return op
      // Each table as copyTable would get it: the insertable columns.
      const details: Record<string, { columns: string[] }> = {}
      for (const table of op.tables) {
        const schema = await adapter.describeTable(ns, table)
        details[table] = {
          columns: schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name),
        }
      }
      return { ...op, details }
    }
    case 'copyTable': {
      if (!op.withData || op.columns !== undefined) return op
      // Generated columns cannot be written (INSERT ... SELECT * would fail after the empty copy was already created,
      // since DDL autocommits).
      const schema = await adapter.describeTable(ns, op.table)
      return { ...op, columns: schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name) }
    }
    case 'renameDatabase':
    case 'copyDatabase':
      return prepareDatabaseOp(adapter, op)
    default:
      return op
  }
}

/**
 * Checks a rename or copy of a whole database and fills in what only the server can know.
 *
 * `tables` and `collation` are always replaced, never taken from the request, so a stale page or a hand-written
 * request cannot move a partial set. (A MySQL rename does not drop the old database, so nothing left off is lost.)
 */
async function prepareDatabaseOp(adapter: DatabaseAdapter, op: DatabaseOp): Promise<DatabaseOp> {
  const { source, rowsOnly } = await checkDatabaseOp(adapter, op)
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
      throw new AdapterError(
        'VALIDATION',
        `"${op.name}" cannot be renamed while it has ${blockers.map(([n, what]) => `${n} ${what}`).join(', ')}: MySQL renames a database by moving its tables, and these would be left behind`
      )
    return { ...op, tables: baseTables, ...(collation ? { collation } : { collation: undefined }) }
  }

  const copy = op.op === 'copyDatabase' ? op : null
  // Rows only: each table must already exist in the target, and only the columns it has are copied.
  const targetTables = rowsOnly ? new Map<string, Set<string>>() : null
  if (targetTables) {
    const targetNs = { database: op.newName }
    const there = (await adapter.listTables(targetNs)).filter((t) => t.kind === 'table').map((t) => t.name)
    const missing = baseTables.filter((n) => !there.includes(n))
    if (missing.length > 0)
      throw new AdapterError(
        'VALIDATION',
        `"${op.newName}" has no table ${missing.map((n) => `"${n}"`).join(', ')}: copying rows only needs the same tables in the target`
      )
    for (const n of baseTables)
      targetTables.set(n, new Set((await adapter.describeTable(targetNs, n)).columns.map((c) => c.name)))
  }
  const tables = await Promise.all(
    baseTables.map(async (name) => {
      const schema = await adapter.describeTable(ns, name)
      const inTarget = targetTables?.get(name)
      return {
        name,
        columns: schema.columns
          .filter((c) => !isGeneratedColumn(c.extra) && (!inTarget || inTarget.has(c.name)))
          .map((c) => c.name),
        // Read here, and only when asked for: the copy carries exactly what the server reports now.
        ...(copy?.autoIncrement && schema.autoIncrement ? { autoIncrement: schema.autoIncrement } : {}),
        ...(copy?.foreignKeys && schema.foreignKeys.length > 0
          ? {
              foreignKeys: schema.foreignKeys.map((fk) => ({
                name: fk.name,
                columns: fk.columns,
                refTable: fk.refTable,
                refDatabase: fk.refNamespace.database,
                refColumns: fk.refColumns,
                ...(fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? { onUpdate: toAction(fk.onUpdate) } : {}),
                ...(fk.onDelete && fk.onDelete !== 'NO ACTION' ? { onDelete: toAction(fk.onDelete) } : {}),
              })),
            }
          : {}),
      }
    })
  )
  const grants = copy?.privileges ? await adapter.databaseGrants(op.name) : undefined
  return { ...op, tables, ...(grants ? { grants } : {}), ...(collation ? { collation } : { collation: undefined }) }
}

/** A referential action the catalog reported, as the builders write it (anything else is left as the default). */
function toAction(value: string): FkAction | undefined {
  const parsed = FkActionSchema.safeParse(value.toUpperCase())
  return parsed.success ? parsed.data : undefined
}
