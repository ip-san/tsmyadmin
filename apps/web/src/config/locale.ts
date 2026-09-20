import { z } from 'zod'
import { readPreference, writePreference } from '@/lib/preferences.ts'
import type { Locale } from './locales/ja.ts'

export type { Locale }

/** The languages the UI ships with, in the order the switcher lists them (each names itself). */
export const LOCALE_NAMES = { ja: '日本語', en: 'English' } as const
export type LocaleCode = keyof typeof LOCALE_NAMES
/** The BCP 47 tag each language formats numbers and dates with (`Intl`, `toLocaleString`). One line per language. */
const INTL_LOCALES: Record<LocaleCode, string> = { ja: 'ja-JP', en: 'en-US' }
export const intlLocaleFor = (code: LocaleCode): string => INTL_LOCALES[code]
export const LOCALE_CODES = Object.keys(LOCALE_NAMES) as [LocaleCode, ...LocaleCode[]]
const LocaleCodeSchema = z.enum(LOCALE_CODES)

/**
 * Where each language's strings come from. One dynamic import per language, so each is its own chunk and only the
 * one in use is downloaded. Adding a language is a file in `locales/`, a line in `LOCALE_NAMES` and a line here (the
 * type refuses a code that has no loader).
 */
const LOADERS: Record<LocaleCode, () => Promise<Locale>> = {
  ja: async () => (await import('./locales/ja.ts')).ja,
  en: async () => (await import('./locales/en.ts')).en,
}
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
    if (code && code in LOCALE_NAMES) return code as LocaleCode
  }
  return 'ja'
}

export const localeCode: LocaleCode = resolveLocaleCode(
  readPreference(LOCALE_PREFERENCE, LocaleCodeSchema.nullable(), null),
  typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
)

/** The tag for formatting numbers and times in the language of this page. */
export const numberLocale = intlLocaleFor(localeCode)

/**
 * The strings of the current language. Resolved once at load: every component reads `locale.*` directly, and
 * `setLocale` reloads the page so a switch cannot leave half the screen in the other language.
 *
 * Only this language is downloaded: the other would be dead weight in the first paint, and the strings are the
 * largest thing that grows with every screen. `loadLocale` fills this in before the app's modules are imported
 * (main.tsx), so the `const t = locale.x` at the top of each of them sees it. Not a top-level await: that makes
 * the bundler preload every route chunk, which undoes the code splitting.
 */
export let locale = undefined as unknown as Locale

/** Downloads this page's language. */
export async function loadLocale(): Promise<void> {
  locale = await LOADERS[localeCode]()
}

export function setLocale(code: LocaleCode): void {
  writePreference(LOCALE_PREFERENCE, code)
  location.reload()
}
