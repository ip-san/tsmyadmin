import { capabilities, type DatabaseInfo, type DdlOp, SYSTEM_DATABASES } from '@tsmyadmin/shared'
import { AdapterError, type DatabaseAdapter } from '../types.ts'

/** A rename or a copy of a whole database. */
export type DatabaseOp = Extract<DdlOp, { op: 'renameDatabase' | 'copyDatabase' }>

/** What the checks found, for the dialect's own preparation to go on from. */
export interface CheckedDatabaseOp {
  /** The database being renamed or copied. */
  source: DatabaseInfo
  /** Rows only: the target is the database the rows go into, so it is there already. */
  rowsOnly: boolean
}

/**
 * What no rename or copy of a whole database may be, on either server: onto itself, of a database the server owns, of one
 * that is not there, onto a name that is taken (unless only the rows go), into a target that is not there (rows only),
 * or rows only on a server that copies from a template. Throws `VALIDATION` / `NOT_FOUND` with the wording the person
 * sees; the dialect's preparation then adds what only its server can say.
 */
export async function checkDatabaseOp(adapter: DatabaseAdapter, op: DatabaseOp): Promise<CheckedDatabaseOp> {
  const { dialect } = adapter
  if (op.name === op.newName) throw new AdapterError('VALIDATION', 'The new name is the same as the current one')
  if (SYSTEM_DATABASES[dialect].has(op.name.toLowerCase()))
    throw new AdapterError('VALIDATION', `"${op.name}" is one of the server's own databases`)
  const databases = await adapter.listDatabases()
  const source = databases.find((d) => d.name === op.name)
  if (!source) throw new AdapterError('NOT_FOUND', `Unknown database: ${op.name}`)
  const existing = databases.find((d) => d.name === op.newName)
  const rowsOnly = op.op === 'copyDatabase' && op.structure === false
  if (rowsOnly && !capabilities(dialect).copyDatabaseWithoutStructure)
    throw new AdapterError('VALIDATION', 'PostgreSQL copies a database with its structure and its data')
  if (rowsOnly && !existing) throw new AdapterError('NOT_FOUND', `Unknown database: ${op.newName}`)
  if (existing && !rowsOnly)
    throw new AdapterError(
      'VALIDATION',
      // Not "empty": the count only covers tables this account can see. A database a MySQL rename left behind is
      // in exactly this state, and may still hold routines or events the account cannot list.
      existing.tableCount === 0
        ? `A database named "${op.newName}" already exists (it has no tables visible to this account)`
        : `A database named "${op.newName}" already exists`
    )
  return { source, rowsOnly }
}
