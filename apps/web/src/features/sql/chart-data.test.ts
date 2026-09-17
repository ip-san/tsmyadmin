import { describe, expect, it } from 'vitest'
import { chartData, MAX_POINTS, niceScale, numericColumns, toNumber } from './chart-data.ts'

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
})
