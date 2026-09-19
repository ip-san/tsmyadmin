import { describe, expect, it } from 'vitest'
import { columnKey, fromRequest, toJoins, toRequest, withoutTable } from './query-builder-model.ts'

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

describe('toJoins', () => {
  it('spells out the joins with a kind and both columns, for tables still chosen', () => {
    const k = (t: string, c: string) => JSON.stringify([t, c])
    expect(
      toJoins(['users', 'posts', 'tags'], {
        posts: { kind: 'left', from: k('posts', 'user_id'), to: k('users', 'id') },
        // Along the foreign key: nothing spelled out.
        tags: { kind: '', from: '', to: '' },
      })
    ).toEqual([
      {
        table: 'posts',
        kind: 'left',
        on: [{ from: { table: 'posts', column: 'user_id' }, to: { table: 'users', column: 'id' } }],
      },
    ])
    // A column of a table no longer chosen: falls back to the foreign key.
    expect(
      toJoins(['users', 'posts'], { posts: { kind: 'inner', from: k('posts', 'id'), to: k('gone', 'id') } })
    ).toEqual([])
  })
})

describe('fromRequest', () => {
  it('puts a saved request back as rows that build the same request', () => {
    let n = 0
    const request = {
      tables: ['users', 'posts'],
      columns: [{ table: 'users', column: 'name', alias: 'who', show: true, sort: 'asc' as const }],
      where: [[{ table: 'posts', column: 'id', op: 'in' as const, values: ['1', '2'] }]],
      joins: [
        {
          table: 'posts',
          kind: 'left' as const,
          on: [{ from: { table: 'posts', column: 'user_id' }, to: { table: 'users', column: 'id' } }],
        },
      ],
    }
    const rows = fromRequest(request, () => ++n)
    expect(toRequest(rows.tables, rows.outputs, rows.groups, undefined, rows.joins)).toEqual(request)
  })
})
