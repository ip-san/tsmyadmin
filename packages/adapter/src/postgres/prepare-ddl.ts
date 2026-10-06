import { type DdlOp, isGeneratedColumn, type Namespace } from '@tsmyadmin/shared'
import { checkDatabaseOp, type DatabaseOp } from '../sql/database-op.ts'
import { AdapterError, type DatabaseAdapter } from '../types.ts'

/** Columns of `table` fed by a sequence of their own (serial, or a sequence OWNED BY the column). */
async function ownedSequenceColumns(
  adapter: DatabaseAdapter,
  ns: Namespace,
  table: string,
  columns: string[]
): Promise<string[]> {
  const schema = await adapter.describeTable(ns, table)
  const own = new Set(schema.columns.filter((col) => col.extra === 'serial').map((col) => col.name))
  for (const t of await adapter.listTables(ns))
    if (t.kind === 'sequence' && t.ownedBy?.table === table && columns.includes(t.ownedBy.column))
      own.add(t.ownedBy.column)
  return [...own]
}

/**
 * Fills in what only the server can say before the SQL of an op is built, for the ops that need it (see
 * `mysqlPrepareDdl`). PostgreSQL's copies also say which columns are identity columns, whose sequence must be advanced
 * past the copied values, and which are serial, whose copy gets a sequence of its own instead of sharing the source's.
 */
export async function pgPrepareDdl(adapter: DatabaseAdapter, ns: Namespace, op: DdlOp): Promise<DdlOp> {
  switch (op.op) {
    case 'copyTable': {
      // A data copy lists the insertable columns: generated columns cannot be written (INSERT ... SELECT * would fail
      // after the empty copy was already created, since DDL autocommits).
      const schema = await adapter.describeTable(ns, op.table)
      return {
        ...op,
        columns: op.columns ?? schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name),
        identityColumns:
          op.identityColumns ?? schema.columns.filter((col) => col.extra.startsWith('identity')).map((col) => col.name),
        // A renamed serial sequence (or CREATE SEQUENCE … OWNED BY) is not `serial` by name but pins the copy to the
        // source's sequence all the same: the owned sequences of the source name those columns.
        serialColumns:
          op.serialColumns ??
          (await ownedSequenceColumns(
            adapter,
            ns,
            op.table,
            schema.columns.map((col) => col.name)
          )),
      }
    }
    case 'setDatabaseCollation': {
      if (!op.applyToTables || op.tables !== undefined) return op
      // The tables as they are now, and their text columns: the preview lists every statement.
      const tables = (await adapter.listTables(ns)).filter((t) => t.kind === 'table').map((t) => t.name)
      const columns: Record<string, { name: string; dataType: string }[]> = {}
      for (const table of tables)
        columns[table] = (await adapter.describeTable(ns, table)).columns
          .filter((col) => /char|text|citext/i.test(col.dataType) && col.generated === null)
          .map((col) => ({ name: col.name, dataType: col.dataType }))
      return { ...op, tables, columns }
    }
    case 'copyTables': {
      if (!op.withData || op.details !== undefined) return op
      // Each table as copyTable would get it: the insertable columns, and its sequences.
      const details: Record<string, { columns: string[]; identityColumns: string[]; serialColumns: string[] }> = {}
      for (const table of op.tables) {
        const schema = await adapter.describeTable(ns, table)
        details[table] = {
          columns: schema.columns.filter((col) => !isGeneratedColumn(col.extra)).map((col) => col.name),
          identityColumns: schema.columns.filter((col) => col.extra.startsWith('identity')).map((col) => col.name),
          serialColumns: await ownedSequenceColumns(
            adapter,
            ns,
            table,
            schema.columns.map((col) => col.name)
          ),
        }
      }
      return { ...op, details }
    }
    case 'renameDatabase':
    case 'copyDatabase':
      return prepareDatabaseOp(adapter, op)
    default:
      return op
  }
}

/** The checks both servers share, and this one's: it cannot rename or copy the database the session is connected through. */
async function prepareDatabaseOp(adapter: DatabaseAdapter, op: DatabaseOp): Promise<DatabaseOp> {
  await checkDatabaseOp(adapter, op)
  // Both statements run on the connection's own database, and PostgreSQL cannot rename or copy that one.
  if (op.name === adapter.serverNamespace.database)
    throw new AdapterError(
      'VALIDATION',
      `"${op.name}" is the database this session is connected through; sign in to another database to change it`
    )
  return op
}
