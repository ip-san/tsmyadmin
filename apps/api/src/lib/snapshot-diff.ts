/**
 * What changed in the schema since a snapshot: the definitions (CREATE statements) it recorded, compared with the
 * ones the database prints now. Only the definitions are compared, never the rows.
 */
import { AdapterError, type DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Namespace, SnapshotDiffEntry } from '@tsmyadmin/shared'
import { SEQUENCE_VALUE } from './export.ts'

/** MariaDB's sequence position (see MysqlAdapter.showCreateTable): it moves with every insert. */
const SEQUENCE_RESTART = /^ALTER SEQUENCE .* RESTART WITH /
/** MySQL's next AUTO_INCREMENT value, among the table options on the closing line: it moves with every insert. */
const AUTO_INCREMENT_OPTION = /^(\)[^\n]*?) AUTO_INCREMENT=\d+/m

/**
 * One object's definition as it is compared: the statements the server printed, without what moves with the rows
 * (a sequence's position, the next AUTO_INCREMENT value). A seed or a test run is not a schema change.
 */
export function comparableDefinition(statements: readonly string[]): string {
  return statements
    .filter((s) => !SEQUENCE_VALUE.test(s) && !SEQUENCE_RESTART.test(s))
    .map((s) => s.replace(AUTO_INCREMENT_OPTION, '$1'))
    .join(';\n')
}

/** The objects of a namespace and their definitions; a name without one could not be read. */
export interface SchemaState {
  names: ReadonlySet<string>
  definitions: ReadonlyMap<string, string>
}

export interface DefinitionsDiff {
  added: SnapshotDiffEntry[]
  removed: SnapshotDiffEntry[]
  changed: SnapshotDiffEntry[]
  unchanged: number
  unreadable: string[]
}

/** The comparison of two states, each list by name. */
export function compareDefinitions(before: SchemaState, after: SchemaState): DefinitionsDiff {
  const out: DefinitionsDiff = { added: [], removed: [], changed: [], unchanged: 0, unreadable: [] }
  const all = [...new Set([...before.names, ...after.names])].sort()
  for (const name of all) {
    const was = before.definitions.get(name) ?? null
    const is = after.definitions.get(name) ?? null
    if (!after.names.has(name)) out.removed.push({ name, before: was, after: null })
    else if (!before.names.has(name)) out.added.push({ name, before: null, after: is })
    else if (was === null || is === null) out.unreadable.push(name)
    else if (was === is) out.unchanged++
    else out.changed.push({ name, before: was, after: is })
  }
  return out
}

/**
 * The namespace as it is now, read through the given adapter (the caller's own session). A view this account cannot
 * SHOW is listed without a definition, as the dump leaves it out; one dropped while it is read is left out.
 */
export async function currentSchema(adapter: DatabaseAdapter, ns: Namespace): Promise<SchemaState> {
  const names = new Set<string>()
  const definitions = new Map<string, string>()
  for (const t of await adapter.listTables(ns)) {
    try {
      const statements = await adapter.showCreateTable(ns, t.name)
      definitions.set(t.name, comparableDefinition(statements))
      names.add(t.name)
    } catch (err) {
      if (!(err instanceof AdapterError)) throw err
      if (err.code === 'PERMISSION_DENIED') names.add(t.name)
      else if (err.code !== 'NOT_FOUND') throw err
    }
  }
  return { names, definitions }
}

/**
 * The adapter a snapshot's dump is read through, recording each definition the dump asks for as it goes by: the
 * comparison needs no second pass over the catalog. Everything else is the adapter itself.
 */
export function recordingDefinitions(adapter: DatabaseAdapter): {
  adapter: DatabaseAdapter
  definitions: Map<string, string>
} {
  const definitions = new Map<string, string>()
  const recording = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'showCreateTable') {
        return async (...args: Parameters<DatabaseAdapter['showCreateTable']>) => {
          const statements = await target.showCreateTable(...args)
          definitions.set(args[1], comparableDefinition(statements))
          return statements
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { adapter: recording, definitions }
}
