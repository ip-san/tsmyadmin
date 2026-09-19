import { describe, expect, it } from 'vitest'
import { defaultSearchOptions, needsStatement } from './SearchOptions.tsx'
import { browseParams, statementRequest } from './search-target.ts'

const all = ['id', 'name', 'age']

describe('search target', () => {
  it('sends a search the browse tab can show there, with its columns, order and page size', () => {
    const o = {
      ...defaultSearchOptions(all),
      columns: ['id', 'age'],
      sort: { column: 'age', direction: 'desc' as const },
      limit: 20,
    }
    expect(needsStatement(o)).toBe(false)
    expect(browseParams([{ column: 'age', op: 'gt', value: '3' }], o, all)).toEqual({
      filters: JSON.stringify([{ column: 'age', op: 'gt', value: '3' }]),
      cols: 'id,age',
      sort: 'age:desc',
      limit: 20,
      page: 1,
    })
    // Every column shown: no `cols`, so the browse tab keeps its own column choice.
    expect(browseParams([], defaultSearchOptions(all), all)).toEqual({ page: 1 })
  })

  it('builds a SELECT for DISTINCT or typed SQL, sorting by a column it does not show', () => {
    const o = {
      ...defaultSearchOptions(all),
      columns: ['name'],
      distinct: true,
      whereSql: '  age > 1 ',
      sort: { column: 'age', direction: 'asc' as const },
    }
    expect(needsStatement(o)).toBe(true)
    expect(statementRequest('t', 's', [{ column: 'id', op: 'in', values: [1, '2'] }], o, all)).toEqual({
      schema: 's',
      tables: ['t'],
      columns: [
        { table: 't', column: 'name', sort: null },
        { table: 't', column: 'age', sort: 'asc', show: false },
      ],
      where: [[{ table: 't', column: 'id', op: 'in', values: ['1', '2'] }]],
      distinct: true,
      whereSql: 'age > 1',
      limit: null,
    })
  })

  it('selects * when every column is shown and nothing is sorted', () => {
    const r = statementRequest('t', undefined, [], { ...defaultSearchOptions(all), distinct: true }, all)
    expect(r.columns).toEqual([])
    expect(r.where).toEqual([])
  })
})
