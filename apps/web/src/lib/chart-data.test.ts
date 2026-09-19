import { describe, expect, it } from 'vitest'
import { chartData, MAX_POINTS, niceScale, numericColumns, scatterPoints, toNumber } from './chart-data.ts'

describe('chart data', () => {
  it('finds plottable columns by their values, digit strings included', () => {
    const rows = [
      ['Alice', 30, '9223372036854775807', null, '1.5e3'],
      ['Bob', null, '12.50', null, 'x'],
    ]
    // name: text; age: numbers and NULL; big: digit strings; all-NULL: nothing to plot; mixed: one non-number.
    expect(numericColumns(5, rows)).toEqual([1, 2])
    expect(toNumber('-0.25')).toBe(-0.25)
    expect(toNumber('12a')).toBeNull()
    // Beyond a double: no scale can be drawn around it.
    expect(toNumber('1e400')).toBeNull()
    expect(toNumber({ $bin: 'AA==' })).toBeNull()
  })

  it('keeps a gap where a row has no number, and caps the points', () => {
    const d = chartData(
      [
        ['a', 1],
        ['b', null],
      ],
      0,
      [1]
    )
    expect(d).toEqual({ labels: ['a', 'b'], series: [{ column: 1, values: [1, null] }], clipped: false })
    const many = Array.from({ length: MAX_POINTS + 1 }, (_, i) => [String(i), i])
    expect(chartData(many, 0, [1])).toMatchObject({ clipped: true })
    expect(chartData(many, 0, [1]).labels).toHaveLength(MAX_POINTS)
  })

  it('picks round ticks that start at zero and cover the data', () => {
    expect(niceScale([3, 41, 25])).toEqual({ min: 0, max: 50, ticks: [0, 10, 20, 30, 40, 50] })
    expect(niceScale([-7, 3]).ticks).toEqual([-8, -6, -4, -2, 0, 2, 4])
    expect(niceScale([0.1, 0.3]).ticks).toEqual([0, 0.1, 0.2, 0.3])
    expect(niceScale([])).toEqual({ min: 0, max: 1, ticks: [0, 1] })
  })

  it('fits a scatter axis to the values rather than stretching it to zero', () => {
    expect(niceScale([1_000_010, 1_000_040], 5, { includeZero: false })).toEqual({
      min: 1_000_010,
      max: 1_000_040,
      ticks: [1_000_010, 1_000_020, 1_000_030, 1_000_040],
    })
    // One value alone still gets an axis around it, not a zero-width one.
    expect(niceScale([7, 7], 5, { includeZero: false }).ticks).toContain(7)
    expect(niceScale([], 5, { includeZero: false })).toEqual({ min: 0, max: 1, ticks: [0, 1] })
  })

  it('places rows with a number on both axes and counts the rest', () => {
    const rows = [
      [1, '2.5', 'a'],
      [null, 3, 'b'],
      ['x', 4, 'c'],
      [5, '6', 'd'],
    ]
    expect(scatterPoints(rows, 0, 1)).toEqual({
      points: [
        { row: 0, x: 1, y: 2.5 },
        { row: 3, x: 5, y: 6 },
      ],
      skipped: 2,
    })
    const many = Array.from({ length: MAX_POINTS + 3 }, (_, i) => [i, i])
    expect(scatterPoints(many, 0, 1).points).toHaveLength(MAX_POINTS)
  })
})

describe('niceScale on values no step fits', () => {
  it('falls back to a plain scale instead of looping', () => {
    expect(niceScale([5e-324, 1e-323], 5, { includeZero: false }).ticks.length).toBeLessThanOrEqual(201)
    expect(niceScale([-Number.MAX_VALUE, Number.MAX_VALUE]).ticks.length).toBeLessThanOrEqual(201)
  })
})
