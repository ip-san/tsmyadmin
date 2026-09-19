import { describe, expect, it } from 'vitest'
import { ColumnTransformBodySchema, transformLink } from './stored.ts'

describe('transformLink', () => {
  it('links only to http and https', () => {
    expect(transformLink('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(transformLink('javascript:alert(1)')).toBeNull()
    expect(transformLink('data:text/html,<b>x</b>')).toBeNull()
    expect(transformLink('not a url')).toBeNull()
  })

  it('puts the value into a template URL-encoded, so it cannot change where the link goes', () => {
    expect(transformLink('42', 'https://shop.example/items/{value}')).toBe('https://shop.example/items/42')
    expect(transformLink('a/../../admin?x=1#y', 'https://shop.example/items/{value}')).toBe(
      'https://shop.example/items/a%2F..%2F..%2Fadmin%3Fx%3D1%23y'
    )
    // Encoded, an `@` cannot turn the template's host into a user name in front of another host.
    expect(transformLink('@evil.example', 'https://shop.example{value}')).toBeNull()
  })

  it('accepts a template only on a link, and only an http(s) one', () => {
    const base = { database: 'd', table: 't', column: 'c' }
    expect(ColumnTransformBodySchema.safeParse({ ...base, kind: 'link', template: 'https://x/{value}' }).success).toBe(
      true
    )
    expect(ColumnTransformBodySchema.safeParse({ ...base, kind: 'link', template: 'javascript:{value}' }).success).toBe(
      false
    )
    expect(ColumnTransformBodySchema.safeParse({ ...base, kind: 'image', template: 'https://x/{value}' }).success).toBe(
      false
    )
  })
})
