import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom reports en-US, which would render the UI in English: the component tests assert the Japanese strings, so
// the browser language is pinned the way a Japanese user's would be (the locale module reads it at import time).
Object.defineProperty(navigator, 'languages', { value: ['ja-JP', 'ja'], configurable: true })

// The app loads its language before its modules (main.tsx); the tests import those modules directly, so the
// strings have to be in place first. Imported after the language is pinned above, so it resolves to Japanese.
const { loadLocale } = await import('../config/locale.ts')
await loadLocale()

// React only treats `act()` as an act scope when this is set; without it state updates in tests warn instead.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
})
