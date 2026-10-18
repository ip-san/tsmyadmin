import type { ColumnProfile } from '@tsmyadmin/shared'

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
