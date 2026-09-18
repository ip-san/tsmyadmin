import { z } from 'zod'

/** One unreadable entry — hand-edited storage, a shape from another version — must not discard the rest. */
const unknownArray = z.array(z.unknown())

import { type PreferenceStore, readPreference, writePreference } from '@/lib/preferences.ts'

/** Matches the per-account cap the server-side lists enforce. */
const NAMED_LIST_LIMIT = 200

function read<T>(key: string, schema: z.ZodType<T>, store?: PreferenceStore): T[] {
  const entries = readPreference<unknown[]>(key, unknownArray, [], store)
  return entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** Things saved under a name in this browser, for deployments whose session store cannot keep them. */
export function loadNamed<T>(key: string, schema: z.ZodType<T>, store?: PreferenceStore): T[] {
  return read(key, schema, store)
}

/** Adds or replaces by name and returns the new list, newest first. */
export function saveNamed<T extends { name: string }>(
  key: string,
  schema: z.ZodType<T>,
  entry: T,
  store?: PreferenceStore
): T[] {
  const next = [entry, ...read(key, schema, store).filter((e) => e.name !== entry.name)].slice(0, NAMED_LIST_LIMIT)
  writePreference(key, next, store)
  return next
}

export function removeNamed<T extends { name: string }>(
  key: string,
  schema: z.ZodType<T>,
  name: string,
  store?: PreferenceStore
): T[] {
  const next = read(key, schema, store).filter((e) => e.name !== name)
  writePreference(key, next, store)
  return next
}
