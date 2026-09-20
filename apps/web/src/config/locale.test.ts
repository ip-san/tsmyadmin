import { describe, expect, it } from 'vitest'
import { intlLocaleFor, LOCALE_NAMES, numberLocale, resolveLocaleCode } from './locale.ts'
import { en } from './locales/en.ts'
import { ja } from './locales/ja.ts'

const LOCALES = { ja, en }

/** Every leaf of a locale, as `path -> 'string' | arity`. */
function shape(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'function') return { [path]: `fn/${value.length}` }
  if (typeof value !== 'object' || value === null) return { [path]: typeof value }
  return Object.assign({}, ...Object.entries(value).map(([k, v]) => shape(v, path ? `${path}.${k}` : k)))
}

describe('locales', () => {
  it('every language has the same keys and the same function arities', () => {
    const reference = shape(LOCALES.ja)
    for (const [code, table] of Object.entries(LOCALES)) {
      expect({ code, shape: shape(table) }).toEqual({ code, shape: reference })
      expect(LOCALE_NAMES[code as keyof typeof LOCALES]).toBeTruthy()
    }
  })

  it('leaves no Japanese in the English strings', () => {
    const japanese = /[ぁ-んァ-ヶ一-龥]/
    const text = (table: unknown, path: string) =>
      path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], table)
    // Symbols and SQL keywords ('≠', 'LIKE', 'NULL') read the same in both languages; Japanese text does not.
    for (const [path, kind] of Object.entries(shape(LOCALES.en)))
      if (kind === 'string')
        expect({ path, japanese: japanese.test(String(text(LOCALES.en, path))) }).toEqual({ path, japanese: false })
  })

  it('picks the language from the preference, then the browser, then Japanese', () => {
    expect(resolveLocaleCode('en', ['ja-JP'])).toBe('en')
    expect(resolveLocaleCode('ja', ['en-US'])).toBe('ja')
    expect(resolveLocaleCode(null, ['en-GB', 'ja'])).toBe('en')
    expect(resolveLocaleCode(null, ['fr-FR', 'ja-JP'])).toBe('ja')
    expect(resolveLocaleCode(null, [])).toBe('ja')
    expect(resolveLocaleCode('klingon', ['de'])).toBe('ja')
  })
})

describe('number and time formats follow the language', () => {
  it('has a format tag for every language, and English groups digits with commas on a 24-hour clock', () => {
    for (const code of Object.keys(LOCALE_NAMES))
      expect(intlLocaleFor(code as keyof typeof LOCALE_NAMES)).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
    expect((1234567).toLocaleString(intlLocaleFor('en'))).toBe('1,234,567')
    expect(
      new Date(Date.UTC(2026, 0, 2, 15, 4, 5)).toLocaleTimeString(intlLocaleFor('en'), {
        hour12: false,
        timeZone: 'UTC',
      })
    ).toBe('15:04:05')
    // The page in Japanese (the test setup's language) formats as Japanese.
    expect(numberLocale).toBe('ja-JP')
  })
})
