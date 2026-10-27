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
      ['a', 'loopOuter', false],
      ['b', 'loopInner', false],
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
      ['a', 'merge', false],
      ['b', 'merge', false],
    ])
    // MySQL 8 on the table it joins through a buffer; MariaDB around it.
    expect(
      roles(node({ op: 'Nested loop', children: [scan('a'), { ...scan('b'), op: 'Table, join buffer (hash join)' }] }))
    ).toEqual([
      ['a', 'loopOuter', false],
      ['b', 'hashProbe', false],
    ])
    expect(
      roles(
        node({ op: 'Nested loop', children: [scan('a'), node({ op: 'Block nested loop', children: [scan('b')] })] })
      )
    ).toEqual([
      ['a', 'loopOuter', false],
      ['b', 'blockInner', false],
    ])
  })

  it('does not take a loop over rows kept (Materialize) as reading the table again for each row', () => {
    const kept = node({ op: 'Nested Loop', children: [scan('a'), node({ op: 'Materialize', children: [scan('b')] })] })
    expect(roles(kept)).toEqual([
      ['a', 'loopOuter', false],
      ['b', null, false],
    ])
  })

  it('marks a read in a subquery run for each row, not one in a table made of a SELECT', () => {
    expect(
      roles(node({ op: 'Sort', children: [scan('a'), node({ op: 'Aggregate SubPlan 1', children: [scan('b')] })] }))
    ).toEqual([
      ['a', null, false],
      ['b', null, true],
    ])
    expect(roles(node({ op: 'Subquery', children: [scan('b')] }))).toEqual([['b', null, true]])
    // PostgreSQL's `FROM (SELECT …) x`: read once.
    expect(roles(node({ op: 'Subquery Scan', children: [scan('b')] }))).toEqual([['b', null, false]])
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
