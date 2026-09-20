import type { Preferences } from '@tsmyadmin/shared'
import { PreferencesSchema } from '@tsmyadmin/shared'
import { z } from 'zod'
import { LOCALE_CODES, localeCode } from '@/config/locale.ts'
import { api, unwrap } from '@/lib/api.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import { setTheme } from '@/lib/theme.ts'

/**
 * Where each shared preference lives in this browser. The browser copy stays the one the screens read; the
 * account's copy (kept by the server when the session store is persistent) is laid over it at login and updated
 * whenever one of these changes, so the settings follow the account to another browser.
 */
export const LOCAL: Record<Exclude<keyof Preferences, 'theme'>, { key: string }> = {
  locale: { key: 'locale' },
  browseLimit: { key: 'browse.limit' },
  browseUnlimited: { key: 'browse.unlimited' },
  sqlSafeMode: { key: 'sql.safeMode' },
  consoleDocked: { key: 'console.docked' },
  sqlHistoryMax: { key: 'sql.historyMax' },
  navGroupDelimiter: { key: 'nav.groupDelimiter' },
  navPageSize: { key: 'nav.pageSize' },
  navHidden: { key: 'nav.hidden' },
  exportDefaults: { key: 'export.defaults' },
  importDefaults: { key: 'import.defaults' },
}

let syncing = false
let loadedFor: string | null = null
let shared: Preferences = {}
/** What changed here since the last send: only that is sent, so a stale copy of the rest cannot overwrite another browser's newer choice. */
let dirty: Preferences = {}
let pending: ReturnType<typeof setTimeout> | null = null

/**
 * Reads the account's preferences once per login and applies them here. Returns whether the language changed —
 * the caller reloads, because every string is read once at load. Nothing happens for a deployment that keeps
 * preferences in the browser only.
 */
/** Drops a change still waiting to be sent: it belongs to the account that made it, not to the next one. */
function cancelPending(): void {
  if (pending !== null) clearTimeout(pending)
  pending = null
}

export async function loadAccountPreferences(identity: string, onServer: boolean): Promise<{ reload: boolean }> {
  if (loadedFor !== identity) {
    // Another account in this tab (a session that expired, then someone else signing in): nothing of the last
    // one's may be sent with this one's cookie.
    cancelPending()
    shared = {}
    dirty = {}
  }
  syncing = onServer
  if (!onServer || loadedFor === identity) return { reload: false }
  loadedFor = identity
  let prefs: Preferences
  try {
    prefs = PreferencesSchema.parse(await unwrap<Preferences>(api.preferences.$get()))
  } catch {
    // Unreachable just now: this browser's own settings still work.
    return { reload: false }
  }
  shared = prefs
  if (prefs.theme) setTheme(prefs.theme)
  let reload = false
  for (const name of Object.keys(LOCAL) as (keyof typeof LOCAL)[]) {
    const value = prefs[name]
    if (value === undefined) continue
    writePreference(LOCAL[name].key, value)
    // Only when the language really was stored: storage that refuses the write (full, or a private window) would
    // otherwise come back with the old language after every reload, and reload again.
    // A language another deployment (or a newer build) has and this one lacks is ignored: reloading would not change it.
    if (
      name === 'locale' &&
      value !== localeCode &&
      (LOCALE_CODES as readonly unknown[]).includes(value) &&
      readPreference(LOCAL[name].key, z.string(), '') === value
    ) {
      reload = true
    }
  }
  return { reload }
}

/** Forgets the account at logout, so the next login reads its own preferences. */
export function resetAccountPreferences(): void {
  cancelPending()
  loadedFor = null
  syncing = false
  shared = {}
  dirty = {}
}

function send(): Promise<unknown> {
  cancelPending()
  const body = dirty
  dirty = {}
  if (Object.keys(body).length === 0) return Promise.resolve()
  // Kept alive so a change made just before a reload (the language switch) still arrives. A failed send keeps the
  // change to go out with the next one.
  return api.preferences.$put({ json: body }, { init: { keepalive: true } }).catch(() => {
    dirty = { ...body, ...dirty }
  })
}

/** Records a change to one of the shared preferences with the account (debounced; a no-op in browser mode). */
export function sharePreference(patch: Preferences): void {
  if (!syncing) return
  shared = { ...shared, ...patch }
  dirty = { ...dirty, ...patch }
  if (pending !== null) clearTimeout(pending)
  pending = setTimeout(() => void send(), 500)
}

/** The same, sent at once: for a change followed by a reload. */
export async function sharePreferenceNow(patch: Preferences): Promise<void> {
  if (!syncing) return
  shared = { ...shared, ...patch }
  dirty = { ...dirty, ...patch }
  await send()
}

/** Removes some preferences from the account (the settings page's reset), sent at once. */
export async function clearSharedPreferences(names: (keyof Preferences)[]): Promise<void> {
  if (!syncing) return
  const gone = Object.fromEntries(names.map((n) => [n, null]))
  const kept = (p: Preferences): Preferences =>
    Object.fromEntries(Object.entries(p).filter(([k]) => !names.includes(k as keyof Preferences)))
  shared = kept(shared)
  dirty = kept(dirty)
  cancelPending()
  await api.preferences.$put({ json: gone }, { init: { keepalive: true } }).catch(() => undefined)
}
