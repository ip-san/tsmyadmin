import { describe, expect, it } from 'vitest'
import { BrowseSearchSchema, browseOptionsFromSearch } from './browse-search.ts'

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
