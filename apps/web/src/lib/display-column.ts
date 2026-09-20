import { z } from 'zod'
import { shareWorkspaceEntry } from './account-prefs.ts'
import { readPreference, removePreference, writePreference } from './preferences.ts'
import type { TableRef } from './queries.ts'

/**
 * phpMyAdmin's "display column": the column that names a row of this table where another table's foreign key
 * points at it. Chosen per table and remembered by the browser; unset, the first text column is used.
 */
const key = (ref: TableRef) => `display-column.${JSON.stringify([ref.db, ref.schema ?? '', ref.table])}`

export function chosenDisplayColumn(ref: TableRef): string | undefined {
  return readPreference(key(ref), z.string().optional(), undefined)
}

export function chooseDisplayColumn(ref: TableRef, column: string | undefined): void {
  if (column === undefined) removePreference(key(ref))
  else writePreference(key(ref), column)
  shareWorkspaceEntry(key(ref), column ?? null)
}
