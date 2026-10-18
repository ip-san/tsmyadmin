import type { ColumnProfile, TableSchema } from '@tsmyadmin/shared'

/**
 * What a table is for, guessed from its keys alone:
 * - `junction`: its primary key is made of the columns of two or more foreign keys (a many-to-many link);
 * - `master`: others refer to it, it refers to none (users, products);
 * - `detail`: it refers to others, none refer to it (order lines, logs);
 * - `middle`: both (orders: they refer to a user, lines refer to them);
 * - `tree`: its only keys are to itself (a parent row of its own: categories, comments, staff and managers);
 * - `isolated`: no key joins it to another table.
 */
type TableRole = 'junction' | 'master' | 'detail' | 'middle' | 'tree' | 'isolated'

export interface RoleGuess {
  role: TableRole
  /** The keys it went by: how many other tables it refers to, and how many others refer to it. */
  refersTo: number
  referredBy: number
  /** A key of its own refers to itself (a parent row). */
  self: boolean
}

/** The role of a table, from its foreign keys and the keys of others that refer to it. */
export function tableRole(
  schema: Pick<TableSchema, 'name' | 'primaryKey' | 'foreignKeys' | 'referencedBy'>
): RoleGuess {
  // Its own name is not another table: a key to itself makes a tree, not a link to the rest.
  const self = schema.foreignKeys.some((k) => k.refTable === schema.name)
  const refersTo = new Set(schema.foreignKeys.map((k) => k.refTable).filter((n) => n !== schema.name)).size
  const referredBy = new Set(schema.referencedBy.map((k) => k.fromTable).filter((n) => n !== schema.name)).size
  const keyed = new Set(schema.foreignKeys.flatMap((k) => k.columns))
  const junction =
    schema.foreignKeys.length >= 2 && schema.primaryKey.length >= 2 && schema.primaryKey.every((c) => keyed.has(c))
  const role: TableRole = junction
    ? 'junction'
    : refersTo > 0 && referredBy > 0
      ? 'middle'
      : referredBy > 0
        ? 'master'
        : refersTo > 0
          ? 'detail'
          : self
            ? 'tree'
            : 'isolated'
  return { role, refersTo, referredBy, self }
}

/** What stands out about a column in the sample: always NULL, one value only, or a different value in every row. */
type ColumnNote = 'allNull' | 'constant' | 'unique'

/**
 * The notes worth a mark, per column: `allNull` (every row sampled is NULL), `constant` (one value, never NULL),
 * `unique` (no two rows alike, in two rows or more). A column whose values are not compared, or are compared by
 * their first characters only, gets `allNull` only.
 * Nothing on an empty sample: no rows say nothing.
 */
export function columnNotes(profile: ColumnProfile): Map<string, ColumnNote> {
  const out = new Map<string, ColumnNote>()
  if (profile.sampled === 0) return out
  for (const c of profile.columns) {
    const present = profile.sampled - c.nulls
    if (present === 0) out.set(c.column, 'allNull')
    // Counted by its first characters, a column may hold more values than it says: nothing is said of how many.
    else if (c.prefix) continue
    else if (c.distinct === 1 && c.nulls === 0) out.set(c.column, 'constant')
    else if (c.distinct !== null && present > 1 && c.distinct === profile.sampled) out.set(c.column, 'unique')
  }
  return out
}
