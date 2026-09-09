import { z } from 'zod'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import { en } from './locales/en.ts'
import { ja, type Locale } from './locales/ja.ts'

export type { Locale }

/** The languages the UI ships with, in the order the switcher lists them. */
export const LOCALES = { ja, en } satisfies Record<string, Locale>
export type LocaleCode = keyof typeof LOCALES
export const LOCALE_NAMES: Record<LocaleCode, string> = { ja: '日本語', en: 'English' }
const LocaleCodeSchema = z.enum(['ja', 'en'])
const LOCALE_PREFERENCE = 'locale'

/**
 * The language to render in: what the user chose, else the first of the browser's languages this build has
 * (`en-GB` counts as English), else Japanese.
 */
export function resolveLocaleCode(stored: string | null, languages: readonly string[]): LocaleCode {
  const chosen = LocaleCodeSchema.safeParse(stored)
  if (chosen.success) return chosen.data
  for (const tag of languages) {
    const code = tag.toLowerCase().split('-')[0]
    if (code && code in LOCALES) return code as LocaleCode
  }
  return 'ja'
}

export const localeCode: LocaleCode = resolveLocaleCode(
  readPreference(LOCALE_PREFERENCE, LocaleCodeSchema.nullable(), null),
  typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
)

/**
 * The strings of the current language. Resolved once at load: every component reads `locale.*` directly, and
 * `setLocale` reloads the page so a switch cannot leave half the screen in the other language.
 */
export const locale: Locale = LOCALES[localeCode]

export function setLocale(code: LocaleCode): void {
  writePreference(LOCALE_PREFERENCE, code)
  location.reload()
}
