import type { Preferences } from '@tsmyadmin/shared'
import { isWorkspaceKey, PreferencesSchema, WorkspaceEntriesSchema, type WorkspaceUpdate } from '@tsmyadmin/shared'
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
  navWidth: { key: 'nav.width' },
  navShowRoutines: { key: 'nav.showRoutines' },
  sqlEnterRuns: { key: 'sql.enterRuns' },
  defaultServerTab: { key: 'tab.server' },
  defaultDbTab: { key: 'tab.db' },
  defaultTableTab: { key: 'tab.table' },
  insertRowCount: { key: 'insert.rows' },
  headerEvery: { key: 'browse.headerEvery' },
  confirmDrop: { key: 'confirm.drop' },
  gridEdit: { key: 'grid.edit' },
  saveOnBlur: { key: 'grid.saveOnBlur' },
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
/** The same for the workspace entries (favourite tables, chosen columns…): keys set since the last send, and keys removed. */
let dirtyKeys: { set: Record<string, unknown>; remove: string[] } = { set: {}, remove: [] }
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
    dirtyKeys = { set: {}, remove: [] }
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
  // Which tables are favourites, the columns chosen for a table…: laid over this browser's the same way.
  try {
    const { entries } = WorkspaceEntriesSchema.parse(await unwrap<unknown>(api.workspace.$get()))
    for (const [key, value] of Object.entries(entries)) writePreference(key, value)
  } catch {
    // Unreachable just now: this browser's own copy still works.
  }
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
  dirtyKeys = { set: {}, remove: [] }
}

function send(): Promise<unknown> {
  cancelPending()
  const body = dirty
  dirty = {}
  const keyed = dirtyKeys
  dirtyKeys = { set: {}, remove: [] }
  const sends: Promise<unknown>[] = []
  // Kept alive so a change made just before a reload (the language switch) still arrives. A failed send keeps the
  // change to go out with the next one.
  if (Object.keys(body).length > 0) {
    sends.push(
      api.preferences.$put({ json: body }, { init: { keepalive: true } }).catch(() => {
        dirty = { ...body, ...dirty }
      })
    )
  }
  if (Object.keys(keyed.set).length > 0 || keyed.remove.length > 0) {
    const update: WorkspaceUpdate = { set: keyed.set, remove: keyed.remove }
    sends.push(
      api.workspace.$put({ json: update }, { init: { keepalive: true } }).catch(() => {
        // Whatever was changed again meanwhile is newer than what failed to go out.
        dirtyKeys = {
          set: { ...keyed.set, ...dirtyKeys.set },
          remove: [...new Set([...keyed.remove, ...dirtyKeys.remove])].filter((k) => !(k in dirtyKeys.set)),
        }
      })
    )
  }
  return Promise.all(sends)
}

/**
 * Records a change to one of the entries the account keeps of how it works with the tables (see
 * WORKSPACE_KEY_PREFIXES): the new value, or `null` when it was removed. Debounced; a no-op in browser mode.
 */
export function shareWorkspaceEntry(key: string, value: unknown | null): void {
  if (!syncing || !isWorkspaceKey(key)) return
  if (value === null) {
    delete dirtyKeys.set[key]
    dirtyKeys.remove = [...new Set([...dirtyKeys.remove, key])]
  } else {
    dirtyKeys.remove = dirtyKeys.remove.filter((k) => k !== key)
    dirtyKeys.set[key] = value
  }
  if (pending !== null) clearTimeout(pending)
  pending = setTimeout(() => void send(), 500)
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
