import { locale as firstPaint, type LocaleCode, localeCode } from './locale.ts'
import type { ScreensLocale } from './locales/screens-ja.ts'

/**
 * Where each language's screen strings come from: one dynamic import per language, so only the one in use is
 * downloaded. Adding a language is a `screens-<code>.ts` next to its `<code>.ts`, and a line here.
 */
const LOADERS: Record<LocaleCode, () => Promise<ScreensLocale>> = {
  ja: async () => (await import('./locales/screens-ja.ts')).jaScreens,
  en: async () => (await import('./locales/screens-en.ts')).enScreens,
}

/**
 * All the strings of the current language: those of first paint (`@/config/locale.ts`) and those of the screens
 * behind the login. A module that reads a screen's strings imports `locale` from here; the type of the one in
 * `locale.ts` has only the first-paint sections, so reading a screen's section through it does not compile.
 *
 * Filled in by `loadScreenStrings`, which the `/_app` route awaits in its `beforeLoad`: the router loads a screen's
 * chunk only after every `beforeLoad` above it has finished, so the `const t = locale.x` at the top of a screen's
 * module sees the strings. Not a top-level await here: that makes the bundler split every route definition into a
 * chunk of its own, and the first paint grows by more than the strings it saves.
 */
export const locale = {} as typeof firstPaint & ScreensLocale

let loading: Promise<void> | undefined

/** Downloads the screens' strings of this page's language, once. */
export function loadScreenStrings(): Promise<void> {
  loading ??= LOADERS[localeCode]().then(
    (screens) => {
      Object.assign(locale, firstPaint, screens)
    },
    (cause: unknown) => {
      // A failed download (a new deploy, the network) is retried on the next navigation.
      loading = undefined
      throw cause
    }
  )
  return loading
}
