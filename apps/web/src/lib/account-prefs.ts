import type { Preferences } from '@tsmyadmin/shared'
import { PreferencesSchema } from '@tsmyadmin/shared'
import { z } from 'zod'
import { localeCode } from '@/config/locale.ts'
import { api, unwrap } from '@/lib/api.ts'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import { setTheme } from '@/lib/theme.ts'

/**
 * Where each shared preference lives in this browser. The browser copy stays the one the screens read; the
 * account's copy (kept by the server when the session store is persistent) is laid over it at login and updated
 * whenever one of these changes, so the settings follow the account to another browser.
 */
const LOCAL: Record<Exclude<keyof Preferences, 'theme'>, { key: string }> = {
  locale: { key: 'locale' },
  browseLimit: { key: 'browse.limit' },
  sqlSafeMode: { key: 'sql.safeMode' },
  consoleDocked: { key: 'console.docked' },
}

let syncing = false
let loadedFor: string | null = null
let shared: Preferences = {}
let pending: ReturnType<typeof setTimeout> | null = null

/**
 * Reads the account's preferences once per login and applies them here. Returns whether the language changed —
 * the caller reloads, because every string is read once at load. Nothing happens for a deployment that keeps
 * preferences in the browser only.
 */
export async function loadAccountPreferences(identity: string, onServer: boolean): Promise<{ reload: boolean }> {
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
    if (name === 'locale' && value !== localeCode && readPreference(LOCAL[name].key, z.string(), '') === value) {
      reload = true
    }
  }
  return { reload }
}

/** Forgets the account at logout, so the next login reads its own preferences. */
export function resetAccountPreferences(): void {
  loadedFor = null
  syncing = false
  shared = {}
}

function send(): Promise<unknown> {
  if (pending !== null) clearTimeout(pending)
  pending = null
  // Kept alive so a change made just before a reload (the language switch) still arrives.
  return api.preferences.$put({ json: shared }, { init: { keepalive: true } }).catch(() => undefined)
}

/** Records a change to one of the shared preferences with the account (debounced; a no-op in browser mode). */
export function sharePreference(patch: Preferences): void {
  if (!syncing) return
  shared = { ...shared, ...patch }
  if (pending !== null) clearTimeout(pending)
  pending = setTimeout(() => void send(), 500)
}

/** The same, sent at once: for a change followed by a reload. */
export async function sharePreferenceNow(patch: Preferences): Promise<void> {
  if (!syncing) return
  shared = { ...shared, ...patch }
  await send()
}
