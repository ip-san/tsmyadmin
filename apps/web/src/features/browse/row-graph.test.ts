import type { Cell, CountKind } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import {
  arrowSentences,
  expandGraph,
  REFERRING_SHOWN,
  type RowGraph,
  type RowNode,
  rowLabel,
  rowNode,
  rowSteps,
} from './row-graph.ts'

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

  it('has no name where the table has no text column, and tells keyless rows apart by their first values', () => {
    const page = {
      ...users,
      keyKind: 'all-columns' as const,
      keyColumns: [],
      columns: [
        { name: 'n', dataType: 'int' },
        { name: 'm', dataType: 'int' },
        { name: 'o', dataType: 'int' },
      ],
    }
    expect(rowLabel(rowNode(ref, page, [5, 6, 7]))).toEqual({ label: 'users n=5, m=6', sublabel: undefined })
    // A ctid table's hidden address is not one of them.
    const ctid = {
      ...page,
      keyKind: 'ctid' as const,
      columns: [page.columns[0] as (typeof page.columns)[0], { name: 'ctid', dataType: 'tid' }],
    }
    expect(rowLabel(rowNode(ref, ctid, [5, '(0,1)'])).label).toBe('users n=5')
  })
})

describe('expandGraph', () => {
  const posts: RowNode['page'] = {
    columns: [
      { name: 'id', dataType: 'int' },
      { name: 'user_id', dataType: 'int' },
    ],
    keyKind: 'pk',
    keyColumns: ['id'],
    foreignKeys: [],
    referencedBy: [],
  }
  const root = rowNode(ref, users, [1, 'Alice'])
  const start: RowGraph = { nodes: new Map([[root.id, root]]), arrows: [], more: [], expanded: new Set() }
  const steps = rowSteps(root)
  const read = (rows: Cell[][], total: number | null, count: CountKind = 'exact') => ({
    ...posts,
    rows,
    total,
    count,
  })
  const tenPosts = Array.from({ length: REFERRING_SHOWN }, (_, i) => [i + 1, 1])

  it('adds the rows read, an arrow from each referring row, and marks the row opened', () => {
    const g = expandGraph(start, root.id, steps, [read([[7, 1]], 1)])
    const post = rowNode({ db: 'shop', schema: undefined, table: 'posts' }, posts, [7, 1])
    expect([...g.nodes.keys()]).toEqual([root.id, post.id])
    expect(g.arrows).toEqual([{ from: post.id, to: root.id, label: 'user_id' }])
    expect(g.more).toEqual([])
    expect(g.expanded.has(root.id)).toBe(true)
    // Opening it again, or meeting the same row, adds nothing twice.
    expect(expandGraph(g, root.id, steps, [read([[7, 1]], 1)]).arrows).toHaveLength(1)
  })

  it('counts the rows left unread when the count is exact', () => {
    const g = expandGraph(start, root.id, steps, [read(tenPosts, 25)])
    expect(g.more).toEqual([expect.objectContaining({ to: root.id, count: 15 })])
    expect(g.arrows.filter((a) => a.from === g.more[0]?.id)).toHaveLength(1)
  })

  it('says only "more" when the count is capped, estimated or missing and the page is full', () => {
    for (const [total, count] of [
      [5000, 'lower_bound'],
      [40, 'estimate'],
      [null, 'exact'],
    ] as const) {
      expect(expandGraph(start, root.id, steps, [read(tenPosts, total, count)]).more[0]?.count).toBeNull()
    }
  })

  it('adds no "more" when everything was read, however the count was taken', () => {
    expect(expandGraph(start, root.id, steps, [read([[7, 1]], 1)]).more).toEqual([])
    expect(expandGraph(start, root.id, steps, [read([[7, 1]], null, 'estimate')]).more).toEqual([])
  })

  it('skips a step whose page did not come back', () => {
    expect(expandGraph(start, root.id, steps, [undefined]).nodes.size).toBe(1)
  })
})

describe('arrowSentences', () => {
  it('says which row refers to which, leaving out the arrows of the unread rows (listed as links)', () => {
    const graph: RowGraph = {
      nodes: new Map(),
      arrows: [
        { from: 'p', to: 'u', label: 'user_id' },
        { from: 'more', to: 'u', label: 'user_id' },
      ],
      more: [{ id: 'more', to: 'u', ref, filters: [], count: 3 }],
      expanded: new Set(),
    }
    expect(
      arrowSentences(
        graph,
        (id) => id.toUpperCase(),
        (a, b, c) => `${a}>${b}:${c}`
      )
    ).toEqual(['P>U:user_id'])
  })
})
