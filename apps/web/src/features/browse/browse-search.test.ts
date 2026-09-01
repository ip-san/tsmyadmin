import { describe, expect, it } from 'vitest'
import { BrowseSearchSchema, browseOptionsFromSearch, encodeColumns, visibleColumnNames } from './browse-search.ts'

describe('browseOptionsFromSearch', () => {
  it('maps page/limit to offset and parses sort', () => {
    expect(browseOptionsFromSearch(BrowseSearchSchema.parse({ page: 3, limit: 25, sort: 'name:desc' }))).toEqual({
      offset: 50,
      limit: 25,
      sort: [{ column: 'name', direction: 'desc' }],
      filters: [],
    })
  })

  it('falls back to no sort/filters when they are malformed', () => {
    expect(browseOptionsFromSearch(BrowseSearchSchema.parse({ sort: 'x:sideways', filters: '{' }))).toEqual({
      offset: 0,
      limit: 50,
      sort: [],
      filters: [],
    })
  })
})

describe('column visibility', () => {
  it('drops unknown names and treats a full set as "all"', () => {
    expect(visibleColumnNames(undefined, ['a', 'b'])).toBeNull()
    expect(visibleColumnNames('b,zzz', ['a', 'b'])).toEqual(['b'])
    expect(visibleColumnNames('a,b', ['a', 'b'])).toBeNull()
    expect(encodeColumns(['a'], ['a', 'b'])).toBe('a')
    expect(encodeColumns(['a', 'b'], ['a', 'b'])).toBeUndefined()
  })
})
