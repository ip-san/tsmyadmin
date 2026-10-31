import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { compareReads, rowsRead, speedup, usesIndex } from './plan-compare.ts'

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
const join = (...children: PlanNode[]) => node({ op: 'Nested Loop', children })
/** A read of a table (a node the plan reads a table at). */
const read = (n: Partial<PlanNode>) => node({ access: 'fullScan', ...n })

describe('compareReads', () => {
  it('pairs each read with the same table under the same name after, wherever the server now reads it', () => {
    const before = join(
      read({ table: 'users', alias: 'u', op: 'u1' }),
      read({ table: 'posts', alias: 'p', op: 'p1' }),
      read({ table: 'posts', alias: 'q', op: 'q1' })
    )
    // The order changed, and the read of posts under q is gone.
    const after = join(read({ table: 'posts', alias: 'p', op: 'p2' }), read({ table: 'users', alias: 'u', op: 'u2' }))
    expect(compareReads(before, after).map((c) => [c.table, c.before.op, c.after?.op ?? null])).toEqual([
      ['users', 'u1', 'u2'],
      ['posts', 'p1', 'p2'],
      ['posts', 'q1', null],
    ])
  })

  it('pairs a table read twice under one name in order', () => {
    const twice = (a: string, b: string) => join(read({ table: 't', op: a }), read({ table: 't', op: b }))
    expect(compareReads(twice('a', 'b'), twice('c', 'd')).map((c) => c.after?.op)).toEqual(['c', 'd'])
  })
})

describe('rowsRead, usesIndex and speedup', () => {
  it('counts the rows over all runs, and none where not measured', () => {
    expect(rowsRead(node({ actual: { rows: 2.5, loops: 4, ms: 1 } }))).toBe(10)
    expect(rowsRead(node({}))).toBeNull()
  })

  it('finds the index by name on that table, case aside', () => {
    const plan = join(read({ table: 'posts', index: 'IDX_POSTS_USER_ID' }), read({ table: 'users', index: 'other' }))
    expect(usesIndex(plan, 'posts', 'idx_posts_user_id')).toBe(true)
    expect(usesIndex(plan, 'users', 'idx_posts_user_id')).toBe(false)
    expect(usesIndex(plan, 'POSTS', 'idx_posts_user_id')).toBe(true)
  })

  it('says how many times faster, and nothing where a run is not timed', () => {
    expect(speedup(400, 4)).toBe(100)
    expect(speedup(4, 8)).toBe(0.5)
    // Under a millisecond either side, a factor is noise.
    expect(speedup(400, 0.2)).toBeNull()
    expect(speedup(0.5, 4)).toBeNull()
    expect(speedup(null, 4)).toBeNull()
  })
})
