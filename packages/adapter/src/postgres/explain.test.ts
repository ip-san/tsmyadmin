import { describe, expect, it } from 'vitest'
import { plan, reads } from '../test/explain-plans/load.ts'
import { parsePgPlan } from './explain.ts'

describe('parsePgPlan', () => {
  it('reads an index scan and a sequential scan under a join', () => {
    const p = parsePgPlan(plan('pg17-q1'))
    expect(p).toMatchObject({ op: 'Nested Loop', table: null, access: null, cost: 9.23, estRows: 1 })
    expect(reads(p)).toEqual(['users as u by uq_users_email range', 'posts as p fullScan'])
    expect(p.children[0]?.detail).toContain('alice@example.com')
  })

  it('follows subplans and hashes', () => {
    expect(reads(parsePgPlan(plan('pg17-q3')))).toEqual([
      'users as u fullScan',
      'posts fullScan',
      'posts as p fullScan',
    ])
    const top = parsePgPlan(plan('pg17-q3'))
    expect(top.children[0]?.children[0]?.children[0]?.op).toBe('Hash Join (Semi)')
    const sub = top.children[0]?.children[1]
    expect(sub?.op).toBe('Aggregate SubPlan 1')
  })

  it('says which table an UPDATE changes', () => {
    const p = parsePgPlan(plan('pg17-q4'))
    expect(p).toMatchObject({ op: 'Update', table: 'posts', access: null })
    expect(reads(p)).toEqual(['posts', 'posts fullScan'])
  })

  it('reads index-only, ordered and bitmap scans', () => {
    const node = (n: Record<string, unknown>) => parsePgPlan([{ Plan: n }])
    expect(
      node({ 'Node Type': 'Index Only Scan', 'Relation Name': 't', 'Index Name': 'i', 'Index Cond': '(a = 1)' })
    ).toMatchObject({
      access: 'range',
      covering: true,
    })
    expect(node({ 'Node Type': 'Index Scan', 'Relation Name': 't', 'Index Name': 'i' }).access).toBe('fullIndexScan')
    expect(
      node({
        'Node Type': 'Bitmap Heap Scan',
        'Relation Name': 't',
        'Recheck Cond': '(a > 1)',
        Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'i_a', 'Index Cond': '(a > 1)' }],
      })
    ).toMatchObject({ index: 'i_a', access: 'range', detail: '(a > 1)' })
  })

  it('makes a node of an empty answer, rather than failing', () => {
    expect(parsePgPlan(null)).toMatchObject({ op: 'Step', children: [] })
  })
})
