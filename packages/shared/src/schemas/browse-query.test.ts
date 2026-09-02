import { describe, expect, it } from 'vitest'
import { BrowseQuerySchema, buildBrowseQuery, encodeSort, parseBrowseQuery } from './browse-query.ts'
import { decodeTableList, encodeTableList } from './export.ts'

describe('browse query', () => {
  it('parses defaults', () => {
    const q = BrowseQuerySchema.parse({})
    expect(parseBrowseQuery(q)).toEqual({ ok: true, options: { offset: 0, limit: 100, sort: [], filters: [] } })
  })

  it('parses sort and filters', () => {
    const q = BrowseQuerySchema.parse({
      offset: '20',
      limit: '10',
      sort: 'name:desc,id',
      filters: JSON.stringify([{ column: 'age', op: 'gt', value: 30 }]),
    })
    expect(parseBrowseQuery(q)).toEqual({
      ok: true,
      options: {
        offset: 20,
        limit: 10,
        sort: [
          { column: 'name', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
        filters: [{ column: 'age', op: 'gt', value: 30 }],
      },
    })
  })

  it('escapes separators inside column names and keeps plain names readable', () => {
    expect(
      encodeSort([
        { column: 'a,b:c', direction: 'desc' },
        { column: 'name', direction: 'asc' },
      ])
    ).toBe('a%2Cb%3Ac:desc,name:asc')
    const q = BrowseQuerySchema.parse({ sort: 'a%2Cb%3Ac:desc,name:asc' })
    expect(parseBrowseQuery(q)).toMatchObject({
      ok: true,
      options: {
        sort: [
          { column: 'a,b:c', direction: 'desc' },
          { column: 'name', direction: 'asc' },
        ],
      },
    })
    // A literal % that is not an escape sequence is taken as written.
    expect(parseBrowseQuery(BrowseQuerySchema.parse({ sort: '100%:asc' }))).toMatchObject({
      ok: true,
      options: { sort: [{ column: '100%', direction: 'asc' }] },
    })
  })

  it('rejects bad sort direction, bad JSON and unknown ops', () => {
    expect(parseBrowseQuery(BrowseQuerySchema.parse({ sort: 'name:sideways' })).ok).toBe(false)
    expect(parseBrowseQuery(BrowseQuerySchema.parse({ filters: '{oops' })).ok).toBe(false)
    expect(parseBrowseQuery(BrowseQuerySchema.parse({ filters: '[{"column":"a","op":"drop"}]' })).ok).toBe(false)
  })

  it('rejects limits over the cap', () => {
    expect(BrowseQuerySchema.safeParse({ limit: '5000' }).success).toBe(false)
  })

  it('round-trips through buildBrowseQuery', () => {
    const options = {
      offset: 5,
      limit: 50,
      sort: [{ column: 'a:b,c%', direction: 'desc' as const }],
      filters: [{ column: 'x', op: 'is_null' as const }],
    }
    const q = BrowseQuerySchema.parse(buildBrowseQuery(options, 'app'))
    expect(q.schema).toBe('app')
    expect(parseBrowseQuery(q)).toEqual({ ok: true, options })
  })
})

describe('encodeTableList / decodeTableList', () => {
  it('round-trips names with commas and spaces, deduplicates, and tolerates unescaped input', () => {
    expect(encodeTableList(['a', 'b,c', ' d', 'a'])).toBe('a,b%2Cc,%20d')
    expect(decodeTableList('a,b%2Cc,%20d')).toEqual(['a', 'b,c', ' d'])
    expect(decodeTableList('users,users,,100%')).toEqual(['users', '100%'])
    expect(decodeTableList(undefined)).toEqual([])
  })
})
