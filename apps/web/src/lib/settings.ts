import {
  ExportOptionsSchema,
  type ImportDefaults,
  ImportDefaultsSchema,
  type Preferences,
  PreferencesSchema,
} from '@tsmyadmin/shared'
import { z } from 'zod'
import { clearSharedPreferences, LOCAL, sharePreferenceNow } from './account-prefs.ts'
import { type PreferenceStore, readPreference, removePreference, writePreference } from './preferences.ts'

/**
 * The settings screen's preferences: every field of `Preferences` but the language and the theme (the header has their
 * own controls). Each is kept in this browser and, where the session store is persistent, with the account.
 */
const SETTING_NAMES = [
  'browseLimit',
  'browseUnlimited',
  'sqlSafeMode',
  'consoleDocked',
  'sqlHistoryMax',
  'navGroupDelimiter',
  'navPageSize',
  'navHidden',
  'exportDefaults',
  'importDefaults',
] as const satisfies readonly (keyof Preferences)[]
type SettingName = (typeof SETTING_NAMES)[number]
export type Settings = Pick<Preferences, SettingName>

export type ResolvedSettings = { [K in SettingName]-?: Exclude<Settings[K], undefined> }

/** What a setting is when nobody chose one: the values the screens use on their own. */
export const SETTING_DEFAULTS: ResolvedSettings = {
  browseLimit: 50,
  browseUnlimited: false,
  sqlSafeMode: true,
  consoleDocked: false,
  sqlHistoryMax: 100,
  navGroupDelimiter: '',
  navPageSize: 0,
  navHidden: [],
  exportDefaults: ExportOptionsSchema.parse({}),
  importDefaults: ImportDefaultsSchema.parse({}),
}

const SHAPES = PreferencesSchema.shape

/** The settings this browser holds (anything missing or invalid is left out). */
export function readSettings(store?: PreferenceStore): Settings {
  const out: Record<string, unknown> = {}
  for (const name of SETTING_NAMES) {
    const raw = readPreference(LOCAL[name].key, z.unknown(), undefined, store)
    if (raw === undefined) continue
    const parsed = SHAPES[name].safeParse(raw)
    if (parsed.success && parsed.data !== undefined) out[name] = parsed.data
  }
  return out as Settings
}

/** Every setting with its value, or the default where none was chosen. */
export function resolveSettings(settings: Settings = readSettings()): ResolvedSettings {
  return { ...SETTING_DEFAULTS, ...settings } as ResolvedSettings
}

export const exportDefaults = () => resolveSettings().exportDefaults
export const importDefaults = (): ImportDefaults => resolveSettings().importDefaults
export const historyLimit = () => resolveSettings().sqlHistoryMax

/** Keeps the settings here and with the account. Names left out of `next` are removed. */
export async function saveSettings(next: Settings): Promise<void> {
  const cleared: SettingName[] = []
  for (const name of SETTING_NAMES) {
    const value = next[name]
    if (value === undefined) {
      removePreference(LOCAL[name].key)
      cleared.push(name)
    } else writePreference(LOCAL[name].key, value)
  }
  await clearSharedPreferences(cleared)
  const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as Preferences
  await sharePreferenceNow(kept)
}

/** Back to the defaults: nothing chosen, here or with the account. */
export const resetSettings = () => saveSettings({})

/** The settings as a file to keep, or to load into another browser. */
export const settingsFile = (settings: Settings): string => `${JSON.stringify(settings, null, 2)}\n`

const FileSchema = PreferencesSchema.pick(
  Object.fromEntries(SETTING_NAMES.map((n) => [n, true])) as Record<SettingName, true>
)

/** The settings a file holds, or null when it is not a settings file. Unknown fields are ignored. */
export function parseSettingsFile(text: string): Settings | null {
  try {
    const parsed = FileSchema.strip().safeParse(JSON.parse(text))
    return parsed.success ? (parsed.data as Settings) : null
  } catch {
    return null
  }
}
