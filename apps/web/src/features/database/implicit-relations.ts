import type { Namespace, RelationDef } from '@tsmyadmin/shared'

/** What a candidate needs of a table: its columns and its primary key. */
export interface TableShape {
  name: string
  columns: readonly string[]
  primaryKey: readonly string[]
}

/** The names a `<name>_id` column may refer to: the name, and its plural (user → users, category → categories). */
function targetsOf(base: string): string[] {
  const out = [base, `${base}s`, `${base}es`]
  if (/[^aeiou]y$/i.test(base)) out.push(`${base.slice(0, -1)}ies`)
  return out
}

/** Marks a candidate's name, so it is never taken for a key of the database. */
const IMPLICIT_PREFIX = '?'

/**
 * Columns named `<name>_id` that no foreign key holds, as keys to the table of that name (or its plural) whose
 * primary key is one column: references the schema keeps by convention, not by constraint. A guess, so they are
 * shown as candidates (made into keys only by the reader). Names are matched case aside; a column named for its
 * own table (`users.user_id`) is not one.
 */
export function implicitRelations(
  tables: readonly TableShape[],
  keys: readonly Pick<RelationDef, 'table' | 'columns'>[],
  ns: Namespace
): RelationDef[] {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  const keyed = new Set(keys.flatMap((k) => k.columns.map((c) => JSON.stringify([k.table, c]))))
  return tables.flatMap((t) =>
    t.columns.flatMap((column): RelationDef[] => {
      const base = /^(.+)_id$/i.exec(column)?.[1]
      if (!base || keyed.has(JSON.stringify([t.name, column]))) return []
      const target = targetsOf(base.toLowerCase())
        .map((n) => byName.get(n))
        .find((x) => x !== undefined)
      // A table's own <name>_id (users.user_id) names itself, not a parent: no line to draw.
      if (!target || target === t || target.primaryKey.length !== 1) return []
      return [
        {
          table: t.name,
          name: `${IMPLICIT_PREFIX}${column}`,
          columns: [column],
          refNamespace: ns,
          refTable: target.name,
          refColumns: [target.primaryKey[0] as string],
          onUpdate: null,
          onDelete: null,
        },
      ]
    })
  )
}
