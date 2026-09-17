import { describe, expect, it } from 'vitest'
import { columnKey, toRequest, withoutTable } from './query-builder-model.ts'

describe('toRequest', () => {
  it('sends only complete rows of chosen tables, in the shape the server expects', () => {
    const outputs = [
      { id: 1, key: columnKey('users', 'name'), alias: ' who ', show: true, sort: 'asc' as const },
      // No column chosen yet.
      { id: 2, key: '', alias: '', show: true, sort: '' as const },
      // Its table was unticked afterwards.
      { id: 3, key: columnKey('posts', 'title'), alias: '', show: true, sort: '' as const },
    ]
    const groups = [
      {
        id: 4,
        conditions: [
          { id: 5, key: columnKey('users', 'age'), op: 'is_null' as const, value: 'left over' },
          { id: 6, key: columnKey('users', 'name'), op: 'eq' as const, value: 'a' },
        ],
      },
      // Every condition in it is of an unchosen table: the group goes too, or it would read as "OR nothing".
      { id: 7, conditions: [{ id: 8, key: columnKey('posts', 'title'), op: 'eq' as const, value: 'x' }] },
    ]
    expect(toRequest(['users'], outputs, groups, 'app')).toEqual({
      schema: 'app',
      tables: ['users'],
      columns: [{ table: 'users', column: 'name', alias: 'who', show: true, sort: 'asc' }],
      where: [
        [
          { table: 'users', column: 'age', op: 'is_null' },
          { table: 'users', column: 'name', op: 'eq', value: 'a' },
        ],
      ],
    })
  })

  it('keeps table and column names apart whatever characters they hold', () => {
    const key = columnKey('a.b', 'c"d')
    const r = toRequest(['a.b'], [{ id: 1, key, alias: '', show: false, sort: '' }], [], undefined)
    expect(r.columns).toEqual([{ table: 'a.b', column: 'c"d', alias: '', show: false, sort: null }])
    expect(r).not.toHaveProperty('schema')
  })
})

describe('withoutTable', () => {
  it("drops the unticked table's rows, and a group left with no conditions", () => {
    const outputs = [
      { id: 1, key: columnKey('users', 'name'), alias: '', show: true, sort: '' as const },
      { id: 2, key: columnKey('posts', 'title'), alias: '', show: true, sort: '' as const },
      { id: 3, key: '', alias: '', show: true, sort: '' as const },
    ]
    const groups = [
      { id: 4, conditions: [{ id: 5, key: columnKey('posts', 'title'), op: 'eq' as const, value: 'x' }] },
      {
        id: 6,
        conditions: [
          { id: 7, key: columnKey('posts', 'id'), op: 'eq' as const, value: '1' },
          { id: 8, key: columnKey('users', 'id'), op: 'eq' as const, value: '1' },
        ],
      },
    ]
    const rest = withoutTable('posts', outputs, groups)
    expect(rest.outputs.map((o) => o.id)).toEqual([1, 3])
    expect(rest.groups).toEqual([{ id: 6, conditions: [groups[1]?.conditions[1]] }])
  })
})
