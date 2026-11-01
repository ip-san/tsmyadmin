import { useMemo, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { readPreference, writePreference } from '@/lib/preferences.ts'

/**
 * The indexes made by "Try an index", until they are dropped: they stay in the database when the plan is closed (or
 * the tab is), so the SQL tab says they are there and offers to drop them. Kept per server in this browser (the index
 * outlives the tab), and only as names: no SQL, no values.
 */
const TriedSchema = z.object({
  db: z.string(),
  schema: z.string().nullable(),
  table: z.string(),
  name: z.string(),
  columns: z.array(z.string()),
  /** Made without stopping writes: dropped the same way. */
  online: z.boolean().optional(),
})
export type TriedIndex = z.infer<typeof TriedSchema>
const ListSchema = z.array(TriedSchema)

const keyOf = (scope: string) => `sql.triedIndexes.${scope}`
const same = (a: TriedIndex, b: TriedIndex) =>
  a.db === b.db && a.schema === b.schema && a.table === b.table && a.name === b.name

const listeners = new Set<() => void>()
const changed = () => {
  for (const l of listeners) l()
}

export const triedIndexes = (scope: string): TriedIndex[] => readPreference(keyOf(scope), ListSchema, [])

export function rememberTried(scope: string, index: TriedIndex): void {
  writePreference(keyOf(scope), [...triedIndexes(scope).filter((x) => !same(x, index)), index])
  changed()
}

export function forgetTried(scope: string, index: TriedIndex): void {
  const list = triedIndexes(scope)
  if (!list.some((x) => same(x, index))) return
  writePreference(
    keyOf(scope),
    list.filter((x) => !same(x, index))
  )
  changed()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab of this browser tried or dropped one.
  const onStorage = () => listener()
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The indexes tried in this database (and schema), as they are remembered now. */
export function useTriedIndexes(scope: string, db: string, schema: string | undefined): TriedIndex[] {
  // The snapshot is the stored text: the same text is the same list, so a render does not loop.
  const raw = useSyncExternalStore(subscribe, () => JSON.stringify(triedIndexes(scope)))
  return useMemo(
    () => (JSON.parse(raw) as TriedIndex[]).filter((x) => x.db === db && x.schema === (schema ?? null)),
    [raw, db, schema]
  )
}
