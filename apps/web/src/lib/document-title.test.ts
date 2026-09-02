import { describe, expect, it } from 'vitest'
import { formatDocumentTitle } from './document-title.ts'

describe('formatDocumentTitle', () => {
  it('joins the specific parts and ends with the app name', () => {
    expect(formatDocumentTitle(['users', 'shop'])).toBe('users – shop – tsmyadmin')
    expect(formatDocumentTitle([undefined, '', 'shop'])).toBe('shop – tsmyadmin')
    expect(formatDocumentTitle([])).toBe('tsmyadmin')
  })
})
