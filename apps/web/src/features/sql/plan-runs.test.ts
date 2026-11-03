import { describe, expect, it } from 'vitest'
import { runsTime, summarizeRuns } from './plan-runs.ts'

describe('summarizeRuns', () => {
  it('says nothing of no runs, and one run as itself', () => {
    expect(summarizeRuns([])).toBeNull()
    expect(summarizeRuns([7])).toEqual({ count: 1, median: 7, min: 7, max: 7 })
  })

  it('takes the middle run, whatever the order they ran in, and the mean of the middle two of an even count', () => {
    expect(summarizeRuns([90, 4, 5])).toEqual({ count: 3, median: 5, min: 4, max: 90 })
    expect(summarizeRuns([10, 2, 4, 6])).toEqual({ count: 4, median: 5, min: 2, max: 10 })
  })
})

describe('runsTime', () => {
  it("compares by the runs' median, or by the one run where none were kept", () => {
    expect(runsTime([30, 3, 4], 3)).toBe(4)
    expect(runsTime([], 12)).toBe(12)
    expect(runsTime([], undefined)).toBeNull()
  })
})
