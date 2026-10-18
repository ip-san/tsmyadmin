import { describe, expect, it } from 'vitest'
import { homeNamespace, namespaceOf } from './home-namespace.ts'

describe('namespaceOf', () => {
  it('names the schema only when there is one', () => {
    expect(namespaceOf('shop', undefined)).toEqual({ database: 'shop' })
    expect(namespaceOf('shop', 'sales')).toEqual({ database: 'shop', schema: 'sales' })
    expect('schema' in namespaceOf('shop', '')).toBe(false)
  })
})

describe('homeNamespace', () => {
  it('on MySQL, takes the database, with no schema, for home', () => {
    const home = homeNamespace('mysql', { database: 'shop' })
    expect(home({ database: 'shop' })).toBe(true)
    expect(home({ database: 'archive' })).toBe(false)
    expect(home({ database: 'shop', schema: 'shop' })).toBe(false)
  })

  it('on PostgreSQL, takes public for home when the page names no schema', () => {
    const home = homeNamespace('postgres', { database: 'app' })
    expect(home({ database: 'app', schema: 'public' })).toBe(true)
    expect(home({ database: 'app', schema: 'audit' })).toBe(false)
    expect(home({ database: 'app' })).toBe(false)
    expect(home({ database: 'other', schema: 'public' })).toBe(false)
  })

  it('on PostgreSQL, takes the schema the page names for home', () => {
    const home = homeNamespace('postgres', { database: 'app', schema: 'audit' })
    expect(home({ database: 'app', schema: 'audit' })).toBe(true)
    expect(home({ database: 'app', schema: 'public' })).toBe(false)
  })
})
