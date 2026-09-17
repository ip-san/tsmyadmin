import { describe, expect, it } from 'vitest'
import { tableTotals } from './table-totals.ts'

describe('tableTotals', () => {
  it('adds up what is known and counts every object', () => {
    expect(
      tableTotals([
        { rowEstimate: 10, sizeBytes: 16384 },
        // A view: no estimate, no size of its own.
        { rowEstimate: null, sizeBytes: null },
        { rowEstimate: 5, sizeBytes: 32768 },
      ])
    ).toEqual({ count: 3, rows: 15, bytes: 49152 })
  })

  it('says unknown rather than zero when nothing has a figure', () => {
    expect(tableTotals([{ rowEstimate: null, sizeBytes: null }])).toEqual({ count: 1, rows: null, bytes: null })
  })
})
