import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { readRows, statsSigns } from './plan-stats.ts'

const read = (table: string, estRows: number | null, more: Partial<PlanNode> = {}): PlanNode => ({
  ...{ op: 'Seq Scan', table, alias: null, index: null, indexColumns: [], access: 'fullScan' as const },
  ...{ covering: false, estRows, cost: null, detail: null, children: [] },
  ...more,
})
const join = (...children: PlanNode[]): PlanNode => ({
  ...read('', null, { op: 'Hash Join', access: null, children }),
  table: null,
})

describe('statsSigns', () => {
  const rows = new Map([
    ['logs', 10_000],
    ['users', 2000],
  ])

  it('names a full read the plan and the table list estimate two times apart or more', () => {
    const plan = join(read('logs', 50_000), read('users', 2100))
    expect(statsSigns(plan, false, null, rows)).toEqual([{ kind: 'list', table: 'logs', plan: 50_000, list: 10_000 }])
  })

  it('says nothing under a limit, of a read with a condition, of small tables, or without the list', () => {
    expect(statsSigns(read('logs', 50_000), true, null, rows)).toEqual([])
    expect(statsSigns(read('logs', 50_000, { detail: '(level = 3)' }), false, null, rows)).toEqual([])
    expect(statsSigns(read('users', 500), false, null, rows)).toEqual([])
    expect(statsSigns(read('logs', 50_000), false, null, undefined)).toEqual([])
  })

  it('names, once measured, a read far off its estimate, before the list, once per table', () => {
    const measured = join(
      read('logs', 120, { access: 'lookup', actual: { rows: 48_000, loops: 1, ms: 30 } }),
      read('users', 2100, { actual: { rows: 2000, loops: 1, ms: 1 } })
    )
    expect(statsSigns(read('logs', 50_000), false, measured, rows)).toEqual([
      { kind: 'measured', table: 'logs', expected: 120, actual: 48_000 },
    ])
  })
})

describe('readRows', () => {
  it("is the plan's rows for its read of the table, whole, or null where it reads none", () => {
    expect(readRows(join(read('logs', 49_999.6), read('users', 3)), 'logs')).toBe(50_000)
    expect(readRows(read('logs', 50_000), 'users')).toBeNull()
    expect(readRows(read('logs', null), 'logs')).toBeNull()
  })
})
