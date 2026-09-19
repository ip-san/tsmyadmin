import { describe, expect, it } from 'vitest'
import type { PreferenceStore } from './preferences.ts'
import { parseSettingsFile, readSettings, resolveSettings, SETTING_DEFAULTS, settingsFile } from './settings.ts'

function memory(entries: Record<string, string>): PreferenceStore {
  const map = new Map(Object.entries(entries))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('settings', () => {
  it('resolves every setting, the default where none was chosen', () => {
    expect(resolveSettings({})).toEqual(SETTING_DEFAULTS)
    expect(resolveSettings({ browseLimit: 25, navHidden: ['a'] })).toMatchObject({
      browseLimit: 25,
      navHidden: ['a'],
      sqlSafeMode: true,
    })
  })

  it('reads what this browser holds and leaves out what is missing or invalid', () => {
    const store = memory({
      'tsmyadmin.pref.nav.pageSize': '80',
      'tsmyadmin.pref.sql.historyMax': '5',
      'tsmyadmin.pref.nav.groupDelimiter': '"_"',
      'tsmyadmin.pref.nav.hidden': 'not json',
    })
    expect(readSettings(store)).toEqual({ navPageSize: 80, navGroupDelimiter: '_' })
  })

  it('writes a settings file that reads back, and refuses anything else', () => {
    const settings = { browseLimit: 100, sqlSafeMode: false, navHidden: ['x'] }
    expect(parseSettingsFile(settingsFile(settings))).toEqual(settings)
    // Fields that are not settings (the theme, an unknown one) are dropped, not carried in.
    expect(parseSettingsFile('{"browseLimit": 20, "theme": "dark", "other": 1}')).toEqual({ browseLimit: 20 })
    expect(parseSettingsFile('{"browseLimit": 0}')).toBeNull()
    expect(parseSettingsFile('[1]')).toBeNull()
    expect(parseSettingsFile('not json')).toBeNull()
  })
})
