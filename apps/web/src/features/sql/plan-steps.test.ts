import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { planReads, planSteps, readSentence, toneOf } from './plan-steps.ts'

const t = locale.plan
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
// A join: users by an index first, then posts in full; an UPDATE above names posts without reading it.
const plan = node({
  op: 'Update',
  table: 'posts',
  children: [
    node({
      op: 'Nested Loop',
      children: [
        node({ op: 'Index Scan', table: 'users', alias: 'u', index: 'uq_email', access: 'lookup', estRows: 1 }),
        node({ op: 'Seq Scan', table: 'posts', access: 'fullScan', estRows: 3.4 }),
      ],
    }),
  ],
})

describe('planReads', () => {
  it('lists the reads of tables in the order they run, with where each sits', () => {
    expect(planReads(plan).map((r) => [r.node.op, r.path])).toEqual([
      ['Index Scan', '0.0.0'],
      ['Seq Scan', '0.0.1'],
    ])
  })
})

describe('planReads, joined', () => {
  const scan = (table: string) => node({ op: 'Seq Scan', table, access: 'fullScan' })
  const roles = (plan: PlanNode) => planReads(plan).map((r) => [r.node.table, r.join, r.subquery])

  it('says how each read is joined: the sides of a loop, and of a hash join read from its last input', () => {
    expect(roles(node({ op: 'Nested Loop', children: [scan('a'), scan('b')] }))).toEqual([
      ['a', 'loopOuter', null],
      ['b', 'loopInner', null],
    ])
    // PostgreSQL and MySQL 9 write the side a hash join builds from last; it is read first. The path stays its place.
    const hash = node({
      op: 'Inner hash join',
      children: [scan('probe'), node({ op: 'Hash', children: [scan('build')] })],
    })
    expect(planReads(hash).map((r) => [r.node.table, r.join, r.path])).toEqual([
      ['build', 'hashBuild', '0.1.0'],
      ['probe', 'hashProbe', '0.0'],
    ])
    expect(roles(node({ op: 'Merge Join', children: [scan('a'), scan('b')] }))).toEqual([
      ['a', 'merge', null],
      ['b', 'merge', null],
    ])
    // MySQL 8 on the table it joins through a buffer; MariaDB around it.
    expect(
      roles(node({ op: 'Nested loop', children: [scan('a'), { ...scan('b'), op: 'Table, join buffer (hash join)' }] }))
    ).toEqual([
      // Which side MySQL 8 hashes is not said: the first table is not said to be read first.
      ['a', null, null],
      ['b', 'hashBuffer', null],
    ])
    expect(
      roles(
        node({ op: 'Nested loop', children: [scan('a'), node({ op: 'Block nested loop', children: [scan('b')] })] })
      )
    ).toEqual([
      ['a', 'loopOuter', null],
      ['b', 'blockInner', null],
    ])
  })

  it('does not take a loop over rows kept (Materialize) as reading the table again for each row', () => {
    const kept = node({ op: 'Nested Loop', children: [scan('a'), node({ op: 'Materialize', children: [scan('b')] })] })
    expect(roles(kept)).toEqual([
      ['a', 'loopOuter', null],
      ['b', null, null],
    ])
  })

  it('marks a read in a subquery run for each row, not one in a table made of a SELECT', () => {
    expect(
      roles(node({ op: 'Sort', children: [scan('a'), node({ op: 'Aggregate SubPlan 1', children: [scan('b')] })] }))
    ).toEqual([
      ['a', null, null],
      ['b', null, 'perRow'],
    ])
    expect(roles(node({ op: 'Subquery', children: [scan('b')] }))).toEqual([['b', null, 'perRow']])
    // PostgreSQL's `FROM (SELECT …) x`: read once.
    expect(roles(node({ op: 'Subquery Scan', children: [scan('b')] }))).toEqual([['b', null, null]])
  })
})

describe('planReads, side plans and wrappers', () => {
  const scan = (table: string) => node({ op: 'Seq Scan', table, access: 'fullScan' })
  const of = (plan: PlanNode) => planReads(plan).map((r) => [r.node.table, r.join, r.subquery, r.repeated])

  it("does not take PostgreSQL's InitPlan or SubPlan for an input of the join they hang under", () => {
    // `WHERE u.age > (SELECT avg(age) FROM users)`: the InitPlan is listed first, and runs once, before the join.
    const init = node({
      op: 'Nested Loop',
      children: [node({ op: 'Aggregate InitPlan 1', children: [scan('x')] }), scan('users'), scan('posts')],
    })
    expect(of(init)).toEqual([
      ['x', null, 'once', false],
      ['users', 'loopOuter', null, false],
      ['posts', 'loopInner', null, false],
    ])
    // A SubPlan listed last under a hash join is not the side it builds from.
    const sub = node({
      op: 'Hash Join',
      children: [
        scan('users'),
        node({ op: 'Hash', children: [scan('posts')] }),
        node({ op: 'Aggregate SubPlan 1', children: [scan('x')] }),
      ],
    })
    expect(of(sub)).toEqual([
      ['posts', 'hashBuild', null, false],
      ['users', 'hashProbe', null, false],
      ['x', null, 'perRow', false],
    ])
  })

  it('does not repeat an InitPlan hung under the inner side of a loop: it runs once', () => {
    const plan = node({
      op: 'Nested Loop',
      children: [
        scan('a'),
        node({
          op: 'Hash Join',
          children: [
            // The InitPlan of b's condition, under the side the loop repeats.
            { ...scan('b'), children: [node({ op: 'Result InitPlan 1', children: [scan('x')] })] },
            node({ op: 'Hash', children: [scan('c')] }),
          ],
        }),
      ],
    })
    expect(of(plan).find((r) => r[0] === 'x')).toEqual(['x', null, 'once', false])
    expect(of(plan).find((r) => r[0] === 'b')).toEqual(['b', 'hashProbe', null, true])
  })

  it("takes MariaDB's join buffer around one table as the side joined to the rows before", () => {
    const wrapped = (op: string) =>
      of(node({ op: 'Nested loop', children: [scan('a'), node({ op, children: [scan('b')] })] }))[1]
    expect(wrapped('Block hash join')).toEqual(['b', 'hashProbe', null, false])
    expect(wrapped('Block nested loop')).toEqual(['b', 'blockInner', null, false])
    expect(wrapped('Batched key access')).toEqual(['b', 'loopInner', null, false])
    // MySQL 8 on the table itself.
    expect(
      of(
        node({
          op: 'Nested loop',
          children: [scan('a'), { ...scan('b'), op: 'Table, join buffer (Batched Key Access)' }],
        })
      )[1]
    ).toEqual(['b', 'loopInner', null, false])
    // A condition that names a join is not one (MySQL 9 writes conditions into the names of its steps).
    expect(of(node({ op: "Filter: (kind = 'merge join')", children: [scan('a'), scan('b')] }))).toEqual([
      ['a', null, null, false],
      ['b', null, null, false],
    ])
  })

  it('marks what a join under the inner side of a loop reads as repeated for each outer row', () => {
    const deep = node({
      op: 'Nested Loop',
      children: [
        scan('a'),
        node({ op: 'Hash Join', children: [scan('b'), node({ op: 'Hash', children: [scan('c')] })] }),
      ],
    })
    expect(of(deep)).toEqual([
      ['a', 'loopOuter', null, false],
      ['c', 'hashBuild', null, true],
      ['b', 'hashProbe', null, true],
    ])
  })
})

describe('toneOf', () => {
  it('tells full reads from reads through an index', () => {
    expect(toneOf('fullScan')).toBe('scan')
    expect(toneOf('fullIndexScan')).toBe('scan')
    expect(toneOf('range')).toBe('index')
    expect(toneOf('lookup')).toBe('index')
    expect(toneOf('other')).toBe('focus')
  })
})

describe('readSentence', () => {
  it('says the table, how it is read, and the rows expected', () => {
    expect(readSentence({ ...node({ access: 'fullScan', estRows: 3.4 }), table: 'posts' })).toBe(
      t.read('posts', t.how.fullScan, t.rows(3))
    )
    expect(readSentence({ ...node({ access: 'range', index: 'i', covering: true }), table: 'users' })).toBe(
      `${t.read('users', t.how.range('i'), '')}${t.covering}`
    )
    expect(readSentence({ ...node({ access: 'fullIndexScan', index: 'i' }), table: 'a' })).toContain(
      t.how.fullIndexScan('i')
    )
    expect(readSentence({ ...node({ access: 'other' }), table: 'a' })).toContain(t.how.other)
  })
})

describe('planSteps', () => {
  it('lights each table read, badged with its index or as a full read', () => {
    const steps = planSteps(planReads(plan))
    expect(steps.map((s) => s.tables)).toEqual([
      [{ name: 'users', tone: 'index', badge: 'uq_email' }],
      [{ name: 'posts', tone: 'scan', badge: t.full }],
    ])
  })

  it('marks the index columns the plan names, or those the structure gives', () => {
    const named = planSteps(planReads(node({ table: 't', access: 'range', index: 'i', indexColumns: ['a'] })))
    expect(named[0]?.columns).toEqual([{ table: 't', column: 'a' }])
    const looked = planSteps(planReads(node({ table: 't', access: 'range', index: 'i' })), (table, index) =>
      table === 't' && index === 'i' ? ['b', 'c'] : []
    )
    expect(looked[0]?.columns).toEqual([
      { table: 't', column: 'b' },
      { table: 't', column: 'c' },
    ])
  })
})
