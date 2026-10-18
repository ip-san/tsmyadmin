import type { ColumnProfile, TableSchema } from '@tsmyadmin/shared'

/**
 * What a table is for, guessed from its keys alone:
 * - `junction`: its primary key is made of the columns of two or more foreign keys (a many-to-many link);
 * - `master`: others refer to it, it refers to none (users, products);
 * - `detail`: it refers to others, none refer to it (order lines, logs);
 * - `middle`: both (orders: they refer to a user, lines refer to them);
 * - `isolated`: no key joins it to another table.
 */
type TableRole = 'junction' | 'master' | 'detail' | 'middle' | 'isolated'

export interface RoleGuess {
  role: TableRole
  /** The keys it went by: how many keys it has to others, and how many tables' keys come to it. */
  refersTo: number
  referredBy: number
}

/** The role of a table, from its foreign keys and the keys of others that refer to it. */
export function tableRole(schema: Pick<TableSchema, 'primaryKey' | 'foreignKeys' | 'referencedBy'>): RoleGuess {
  const refersTo = new Set(schema.foreignKeys.map((k) => k.refTable)).size
  const referredBy = new Set(schema.referencedBy.map((k) => k.fromTable)).size
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
          : 'isolated'
  return { role, refersTo, referredBy }
}

/** What stands out about a column in the sample: always NULL, one value only, or a different value in every row. */
type ColumnNote = 'allNull' | 'constant' | 'unique'

/**
 * The notes worth a mark, per column: `allNull` (every row sampled is NULL), `constant` (one value, never NULL),
 * `unique` (no two rows alike, in two rows or more). A column whose values are not compared gets `allNull` only.
 * Nothing on an empty sample: no rows say nothing.
 */
export function columnNotes(profile: ColumnProfile): Map<string, ColumnNote> {
  const out = new Map<string, ColumnNote>()
  if (profile.sampled === 0) return out
  for (const c of profile.columns) {
    const present = profile.sampled - c.nulls
    if (present === 0) out.set(c.column, 'allNull')
    else if (c.distinct === 1 && c.nulls === 0) out.set(c.column, 'constant')
    else if (c.distinct !== null && present > 1 && c.distinct === profile.sampled) out.set(c.column, 'unique')
  }
  return out
}
