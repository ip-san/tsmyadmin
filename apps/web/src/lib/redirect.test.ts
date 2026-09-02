import { describe, expect, it } from 'vitest'
import { safeRedirect } from './redirect.ts'

describe('safeRedirect', () => {
  it('keeps same-origin paths including search and hash', () => {
    expect(safeRedirect('/db/shop/table/users?page=3&cols=id#x')).toBe('/db/shop/table/users?page=3&cols=id#x')
  })

  it.each(['', undefined, 'https://evil.example/', '//evil.example', '/\\evil.example', 'db/shop', 'javascript:1'])(
    'falls back to / for %s',
    (t) => {
      expect(safeRedirect(t)).toBe('/')
    }
  )

  it('never redirects back to the login page', () => {
    expect(safeRedirect('/login')).toBe('/')
    expect(safeRedirect('/login?redirect=%2Fdb')).toBe('/')
  })
})
