import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { conditionColumns, indexCandidates, indexName, type TableShape } from './plan-index.ts'

const node = (n: Partial<PlanNode>): PlanNode => ({
  op: 'Step',
  table: null,
  alias: null,
  index: null,
  indexColumns: [],
  access: null,
  covering: false,
  estRows: null,
  cost: null,
  detail: null,
  children: [],
  ...n,
})
const SHAPES: Record<string, TableShape> = {
  users: {
    columns: ['id', 'name', 'email', 'age'],
    indexes: [
      { name: 'PRIMARY', columns: ['id'] },
      { name: 'idx_users_name', columns: ['name'] },
    ],
  },
  posts: {
    columns: ['id', 'user_id', 'title', 'status', 'created_at'],
    indexes: [{ name: 'posts_pkey', columns: ['id'] }],
  },
}
const shapeOf = (t: string) => SHAPES[t]
const cols = (text: string, table = 'posts', alias: string | null = null) =>
  conditionColumns(text, table, alias, SHAPES[table]?.columns ?? [])

describe('conditionColumns', () => {
  // The strings below are as the servers wrote them in the captured plans.
  it('reads a column through casts and quotes, as each server writes it', () => {
    expect(cols("((email)::text = 'alice@example.com'::text)", 'users')).toEqual([{ column: 'email', use: 'equal' }])
    expect(cols('(`tsmyadmin_test`.`posts`.`id` = 1)')).toEqual([{ column: 'id', use: 'equal' }])
    expect(cols('posts.`id` = 1')).toEqual([{ column: 'id', use: 'equal' }])
  })

  it('takes a name qualified by another table as that table’s', () => {
    expect(cols('(u.id = p.user_id)', 'posts', 'p')).toEqual([{ column: 'user_id', use: 'equal' }])
    expect(cols('(u.id = posts.user_id)')).toEqual([{ column: 'user_id', use: 'equal' }])
    // Unqualified, the scan's own (PostgreSQL qualifies only where two tables meet).
    expect(cols('(user_id = u.id)')).toEqual([{ column: 'user_id', use: 'equal' }])
  })

  it('tells a value from a name, and an equality from a range', () => {
    expect(cols("(title = 'user_id')")).toEqual([{ column: 'title', use: 'equal' }])
    expect(cols('(1 = status)')).toEqual([{ column: 'status', use: 'equal' }])
    expect(cols('(status IN (1, 2))')).toEqual([{ column: 'status', use: 'equal' }])
    for (const range of ['(created_at > 5)', '(created_at <= 5)', '(5 >= created_at)'])
      expect(cols(range)).toEqual([{ column: 'created_at', use: 'range' }])
  })

  it('says a pattern starting with a wildcard, or a match ignoring case, is no use to an index', () => {
    expect(cols("(title LIKE '%x')")).toEqual([{ column: 'title', use: 'none' }])
    expect(cols("((title)::text ~~ '%x'::text)")).toEqual([{ column: 'title', use: 'none' }])
    expect(cols("((title)::text ~~* 'x%'::text)")).toEqual([{ column: 'title', use: 'none' }])
    expect(cols("((title)::text ~~ 'A%'::text)")).toEqual([{ column: 'title', use: 'range' }])
  })

  it('takes no column from a value, a function or a type, whatever the table names its columns', () => {
    const odd = ['id', 'value', 'name', 'hash', 'date', 'pattern', 'lower', 'level']
    const of = (text: string) => conditionColumns(text, 't', null, odd)
    expect(of("(t.name = 'x')")).toEqual([{ column: 'name', use: 'equal' }])
    expect(of("(t.name LIKE '%x')")).toEqual([{ column: 'name', use: 'none' }])
    expect(of("(date(t.level) = DATE '2020-01-01')")).toEqual([{ column: 'level', use: 'none' }])
    expect(of("(lower((name)::text) = 'x'::text)")).toEqual([{ column: 'name', use: 'none' }])
    // The words of a step's name are no columns: only its condition is read.
    expect(of('(t.hash = u.x)')).toEqual([{ column: 'hash', use: 'equal' }])
  })

  it('says a computed column, a not-equal, and either side of an OR are no use to an index', () => {
    expect(cols('((status + 1) = 3)')).toEqual([{ column: 'status', use: 'none' }])
    expect(cols('(status <> 3)')).toEqual([{ column: 'status', use: 'none' }])
    expect(cols('(status != 3)')).toEqual([{ column: 'status', use: 'none' }])
    expect(cols("((status = 1) OR (title = 'a'))")).toEqual([
      { column: 'status', use: 'none' },
      { column: 'title', use: 'none' },
    ])
    // A group opened by AND is no function.
    expect(cols("((status = 1) AND (title = 'a'))")).toEqual([
      { column: 'status', use: 'equal' },
      { column: 'title', use: 'equal' },
    ])
  })

  it('keeps a column said twice at its best use', () => {
    expect(cols('((status > 1) AND (status = 2))')).toEqual([{ column: 'status', use: 'equal' }])
  })
})

describe('indexName', () => {
  it('names the index after the table and columns, short enough for both servers, and not one taken', () => {
    expect(indexName('posts', ['user_id'], [])).toBe('idx_posts_user_id')
    expect(indexName('posts', ['user_id'], ['IDX_POSTS_USER_ID'])).toBe('idx_posts_user_id_2')
    expect(indexName('posts', ['user_id'], ['idx_posts_user_id', 'idx_posts_user_id_2'])).toBe('idx_posts_user_id_3')
    const long = indexName('t'.repeat(50), ['c'.repeat(30)], [])
    expect(long).toHaveLength(60)
    expect(indexName('t'.repeat(50), ['c'.repeat(30)], [long])).toHaveLength(60)
    expect(indexName('my table', ['a-b'], [])).toBe('idx_my_table_a_b')
  })
})

describe('indexCandidates', () => {
  it('tries an index for the inner side of a loop read in full, from the loop’s condition', () => {
    const plan = node({
      op: 'Nested Loop',
      detail: '(u.id = p.user_id)',
      children: [
        node({ op: 'Index Scan', table: 'users', alias: 'u', access: 'lookup', estRows: 1 }),
        node({ op: 'Seq Scan', table: 'posts', alias: 'p', access: 'fullScan', estRows: 5000 }),
      ],
    })
    expect(indexCandidates(plan, shapeOf)).toEqual([
      { table: 'posts', columns: ['user_id'], name: 'idx_posts_user_id', reason: 'perRow' },
    ])
  })

  it('reads only the condition of a step’s name, not its words', () => {
    const shape: TableShape = { columns: ['id', 'hash', 'inner', 'join'], indexes: [] }
    const plan = node({
      op: 'Inner hash join (u.id = t.id)',
      estRows: 1,
      children: [
        node({ op: 'Table scan on t', table: 't', access: 'fullScan', estRows: 1000 }),
        node({ op: 'Index lookup on u', table: 'u', access: 'lookup' }),
      ],
    })
    expect(indexCandidates(plan, () => shape)).toEqual([
      { table: 't', columns: ['id'], name: 'idx_t_id', reason: 'waste' },
    ])
  })

  it('tries one for a hash join only where it keeps few of the rows read', () => {
    const hash = (rows: number) =>
      node({
        op: 'Hash Join',
        detail: '(u.id = p.user_id)',
        estRows: rows,
        children: [
          node({ op: 'Seq Scan', table: 'posts', alias: 'p', access: 'fullScan', estRows: 1000 }),
          node({ op: 'Hash', children: [node({ op: 'Index Scan', table: 'users', alias: 'u', access: 'lookup' })] }),
        ],
      })
    expect(indexCandidates(hash(100), shapeOf).map((c) => c.columns)).toEqual([['user_id']])
    expect(indexCandidates(hash(101), shapeOf)).toEqual([])
  })

  it('puts the equal columns first and one range after, and reads a Filter step above a scan (MySQL 9)', () => {
    const plan = node({
      op: "Filter: ((posts.created_at > '2024-01-01') and (posts.status = 2) and (posts.title like '%x'))",
      children: [node({ op: 'Table scan on posts', table: 'posts', access: 'fullScan', estRows: 9 })],
    })
    expect(indexCandidates(plan, shapeOf)).toEqual([
      { table: 'posts', columns: ['status', 'created_at'], name: 'idx_posts_status_created_at', reason: 'filter' },
    ])
  })

  it('counts a column once where the server writes the condition twice (MySQL: as the step and as its condition)', () => {
    const condition = '(posts.`status` = 3)'
    const plan = node({
      op: `Filter: ${condition}`,
      detail: condition,
      children: [node({ op: 'Table scan on posts', table: 'posts', access: 'fullScan', estRows: 9 })],
    })
    expect(indexCandidates(plan, shapeOf).map((c) => c.columns)).toEqual([['status']])
    // A column equal in one condition and a range in another is used as equal, once.
    const both = node({
      op: 'Filter: (posts.created_at > 1)',
      detail: '(posts.created_at = 2)',
      children: [node({ op: 'Table scan on posts', table: 'posts', access: 'fullScan', estRows: 9 })],
    })
    expect(indexCandidates(both, shapeOf).map((c) => c.columns)).toEqual([['created_at']])
  })

  it('reads no condition from a step that only sorts', () => {
    const plan = node({
      op: 'Sort',
      detail: 'posts.status',
      children: [node({ op: 'Seq Scan', table: 'posts', access: 'fullScan', estRows: 9 })],
    })
    expect(indexCandidates(plan, shapeOf)).toEqual([])
  })

  it('tries nothing where the table is read through an index, an index has the columns, or none could help', () => {
    const scan = (detail: string, table = 'posts', access: PlanNode['access'] = 'fullScan') =>
      node({ op: 'Seq Scan', table, access, detail, estRows: 9 })
    expect(indexCandidates(scan('(user_id = 1)', 'posts', 'range'), shapeOf)).toEqual([])
    expect(indexCandidates(scan("((name)::text = 'A'::text)", 'users'), shapeOf)).toEqual([])
    expect(indexCandidates(scan("((title)::text ~~ '%x'::text)"), shapeOf)).toEqual([])
    expect(indexCandidates(scan('(id = 1)', 'nowhere'), shapeOf)).toEqual([])
  })

  it('counts a subquery run per row as a join', () => {
    const plan = node({
      op: 'Seq Scan',
      table: 'users',
      alias: 'u',
      access: 'fullScan',
      children: [
        node({
          op: 'Aggregate SubPlan 1',
          children: [
            node({ op: 'Seq Scan', table: 'posts', alias: 'p', access: 'fullScan', detail: '(user_id = u.id)' }),
          ],
        }),
      ],
    })
    expect(indexCandidates(plan, shapeOf)).toEqual([
      { table: 'posts', columns: ['user_id'], name: 'idx_posts_user_id', reason: 'perRow' },
    ])
  })
})
