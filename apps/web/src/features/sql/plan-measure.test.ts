import type { PlanNode } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { heavyShare, misestimate } from './plan-measure.ts'

const read = (estRows: number | null, actual?: PlanNode['actual']): PlanNode => ({
  ...{ op: 'Seq Scan', table: 't', alias: null, index: null, indexColumns: [], access: 'fullScan' as const },
  ...{ covering: false, estRows, cost: null, detail: null, children: [] },
  ...(actual ? { actual } : {}),
})

describe('misestimate', () => {
  it('names a step ten times off or more, either way, per run of the step', () => {
    expect(misestimate(read(12, { rows: 48_000, loops: 1, ms: 5 }))).toEqual({
      expected: 12,
      actual: 48_000,
      factor: 4000,
      more: true,
    })
    expect(misestimate(read(5000, { rows: 50, loops: 3, ms: 5 }))).toEqual({
      expected: 5000,
      actual: 50,
      factor: 100,
      more: false,
    })
    // Exactly ten times: said.
    expect(misestimate(read(100, { rows: 1000, loops: 1, ms: 1 }))?.factor).toBe(10)
    // An estimate of none: counted as one, never a division by zero.
    expect(misestimate(read(0, { rows: 500, loops: 1, ms: 1 }))).toMatchObject({ factor: 500, more: true })
  })

  it('says nothing of a close step, of small numbers, of a step never run, or of an estimate', () => {
    expect(misestimate(read(200, { rows: 1999, loops: 1, ms: 1 }))).toBeNull()
    expect(misestimate(read(1, { rows: 99, loops: 1, ms: 1 }))).toBeNull()
    expect(misestimate(read(1, { rows: 100, loops: 1, ms: 1 }))).not.toBeNull()
    expect(misestimate(read(5000, { rows: 0, loops: 0, ms: null }))).toBeNull()
    expect(misestimate(read(5000))).toBeNull()
    expect(misestimate(read(null, { rows: 5000, loops: 1, ms: 1 }))).toBeNull()
  })
})

describe('heavyShare', () => {
  it('gives the share of a step that took half the run or more, of a run long enough to tell', () => {
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: 30 }), 40)).toBe(75)
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: 20 }), 40)).toBe(50)
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: 19 }), 40)).toBeNull()
    // Too quick to mean anything, or not timed.
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: 9 }), 9.9)).toBeNull()
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: null }), 40)).toBeNull()
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: 30 }), null)).toBeNull()
    // MariaDB's table time and the run's are timed apart: never past the whole.
    expect(heavyShare(read(1, { rows: 1, loops: 1, ms: 50 }), 40)).toBe(100)
  })
})
