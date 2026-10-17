import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale.ts'
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
