import { describe, expect, it } from 'vitest'
import { REFERRING_SHOWN, type RowNode, rowLabel, rowNode, rowSteps } from './row-graph.ts'

const users: RowNode['page'] = {
  columns: [
    { name: 'id', dataType: 'int' },
    { name: 'name', dataType: 'varchar' },
  ],
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [],
  referencedBy: [
    {
      name: 'fk_posts_user',
      fromNamespace: { database: 'shop' },
      fromTable: 'posts',
      fromColumns: ['user_id'],
      columns: ['id'],
    },
  ],
}
const lines: RowNode['page'] = {
  columns: [
    { name: 'id', dataType: 'int' },
    { name: 'order_id', dataType: 'int' },
    { name: 'shop_id', dataType: 'int' },
    { name: 'note', dataType: 'text' },
  ],
  keyKind: 'pk',
  keyColumns: ['id'],
  foreignKeys: [
    {
      name: 'fk_line_order',
      columns: ['order_id', 'shop_id'],
      refNamespace: { database: 'shop', schema: 'app' },
      refTable: 'orders',
      refColumns: ['id', 'shop'],
      onUpdate: null,
      onDelete: null,
    },
  ],
  referencedBy: [],
}
const ref = { db: 'shop', table: 'users' }

describe('rowNode', () => {
  it('names a row by its table and key', () => {
    const a = rowNode(ref, users, [1, 'Alice'])
    expect(a.id).toBe(JSON.stringify(['shop', '', 'users', [1]]))
    expect(a.values.get('name')).toBe('Alice')
    expect(rowNode(ref, users, [1, 'renamed']).id).toBe(a.id)
  })

  it('names a row of a table without a key by all its values, leaving out the hidden ctid', () => {
    const page = {
      ...users,
      keyKind: 'ctid' as const,
      keyColumns: ['ctid'],
      columns: [...users.columns, { name: 'ctid', dataType: 'tid' }],
    }
    const n = rowNode(ref, page, [1, 'Alice', '(0,1)'])
    expect([...n.values.keys()]).toEqual(['id', 'name'])
    expect(n.id).toBe(JSON.stringify(['shop', '', 'users', [1, 'Alice']]))
  })
})

describe('rowSteps', () => {
  it('reads the rows that refer to a row, a page at most, by the referring columns', () => {
    expect(rowSteps(rowNode(ref, users, [1, 'Alice']))).toEqual([
      {
        ref: { db: 'shop', schema: undefined, table: 'posts' },
        options: { offset: 0, limit: REFERRING_SHOWN, sort: [], filters: [{ column: 'user_id', op: 'eq', value: 1 }] },
        direction: 'in',
        label: 'user_id',
      },
    ])
  })

  it('reads the one row a key of several columns refers to, column by column', () => {
    const [step] = rowSteps(rowNode({ db: 'shop', table: 'lines' }, lines, [7, 3, 9, 'x']))
    expect(step).toEqual({
      ref: { db: 'shop', schema: 'app', table: 'orders' },
      options: {
        offset: 0,
        limit: 1,
        sort: [],
        filters: [
          { column: 'id', op: 'eq', value: 3 },
          { column: 'shop', op: 'eq', value: 9 },
        ],
      },
      direction: 'out',
      label: 'order_id, shop_id',
    })
  })

  it('follows no key with a NULL, a binary value or a cut value in it', () => {
    const lineRef = { db: 'shop', table: 'lines' }
    expect(rowSteps(rowNode(lineRef, lines, [7, null, 9, 'x']))).toEqual([])
    expect(rowSteps(rowNode(lineRef, lines, [7, { $bin: 'AA==' }, 9, 'x']))).toEqual([])
    expect(rowSteps(rowNode(lineRef, lines, [7, { $text: '12', length: 99 }, 9, 'x']))).toEqual([])
  })
})

describe('rowLabel', () => {
  it("says the table and key, and the first text column as the row's name", () => {
    expect(rowLabel(rowNode(ref, users, [1, 'Alice']))).toEqual({ label: 'users id=1', sublabel: 'Alice' })
  })

  it('has no name where the table has no text column, and no key where it has none', () => {
    const page = {
      ...users,
      keyKind: 'all-columns' as const,
      keyColumns: [],
      columns: [{ name: 'n', dataType: 'int' }],
    }
    expect(rowLabel(rowNode(ref, page, [5]))).toEqual({ label: 'users', sublabel: undefined })
  })
})
