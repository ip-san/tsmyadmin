import type { z } from 'zod'

const PREFIX = 'tsmyadmin.pref.'

export type PreferenceStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): PreferenceStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Reads a per-browser preference; anything missing, unparsable or failing `schema` yields `fallback`. */
export function readPreference<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  store: PreferenceStore | null | undefined = storage()
): T {
  try {
    const raw = store?.getItem(PREFIX + key)
    if (raw === null || raw === undefined) return fallback
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

/** Persists a preference; storage errors (private mode, quota) are ignored — preferences are a convenience. */
export function writePreference<T>(key: string, value: T, store: PreferenceStore | null | undefined = storage()): void {
  try {
    store?.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function removePreference(key: string, store: PreferenceStore | null | undefined = storage()): void {
  try {
    store?.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}
