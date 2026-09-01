import { describe, expect, it } from 'vitest'
import { BrowseQuerySchema, buildBrowseQuery, parseBrowseQuery } from './browse-query.ts'

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
      sort: [{ column: 'a:b', direction: 'desc' as const }],
      filters: [{ column: 'x', op: 'is_null' as const }],
    }
    const q = BrowseQuerySchema.parse(buildBrowseQuery(options, 'app'))
    expect(q.schema).toBe('app')
    expect(parseBrowseQuery(q)).toEqual({ ok: true, options })
  })
})
