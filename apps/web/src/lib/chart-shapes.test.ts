import { describe, expect, it } from 'vitest'
import { areaPath, parseTime, pieAngles, polylinePath, slicePath, splinePath, timeLabel } from './chart-shapes.ts'

describe('lines', () => {
  it('draws a straight line and lifts the pen at a missing value', () => {
    expect(polylinePath([[0, 0], [10, 5], null, [30, 5]])).toBe('M 0 0 L 10 5 M 30 5')
    expect(polylinePath([null, null])).toBe('')
  })

  it('draws a smooth curve with one segment per pair of points, and cuts it at a gap', () => {
    const d = splinePath([[0, 0], [10, 10], [20, 0], null, [40, 0], [50, 10]])
    expect(d.match(/M /g)).toHaveLength(2)
    expect(d.match(/C /g)).toHaveLength(3)
    expect(splinePath([[5, 5]])).toBe('M 5 5')
  })

  it('closes an area down to the baseline, one shape per run', () => {
    expect(areaPath([[0, 4], [10, 2], null, [30, 1]], 10)).toBe(
      'M 0 10 L 0 4 L 10 2 L 10 10 Z M 30 10 L 30 1 L 30 10 Z'
    )
  })
})

describe('pie', () => {
  it('shares the circle by the positive values only', () => {
    const angles = pieAngles([1, 3, 0, null, -2])
    expect(angles.map((a) => a.share)).toEqual([0.25, 0.75, 0, 0, 0])
    expect(angles[1]?.to).toBeCloseTo(-Math.PI / 2 + Math.PI * 2)
    expect(pieAngles([0, null]).every((a) => a.share === 0)).toBe(true)
  })

  it('draws a slice, a large one flagged, and a whole circle as two arcs', () => {
    expect(slicePath(100, 100, 50, -Math.PI / 2, 0)).toBe('M 100 100 L 100 50 A 50 50 0 0 1 150 100 Z')
    expect(slicePath(100, 100, 50, -Math.PI / 2, Math.PI)).toContain(' 0 1 1 ')
    expect(slicePath(100, 100, 50, -Math.PI / 2, (3 * Math.PI) / 2).match(/A /g)).toHaveLength(2)
  })
})

describe('time', () => {
  it('reads the dates and date-times a server returns, and nothing else', () => {
    expect(parseTime('2026-01-02')).toBe(Date.UTC(2026, 0, 2))
    expect(parseTime('2026-01-02 03:04:05')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(parseTime('2026-01-02T03:04')).toBe(Date.UTC(2026, 0, 2, 3, 4))
    expect(parseTime('2026-13-45')).toBeNull()
    expect(parseTime('12')).toBeNull()
    expect(parseTime('yesterday')).toBeNull()
  })

  it('labels an axis with the date, or with the time of day when the range is short', () => {
    const t = Date.UTC(2026, 0, 2, 3, 4)
    expect(timeLabel(t, 10 * 86_400_000)).toBe('2026-01-02')
    expect(timeLabel(t, 3_600_000)).toBe('2026-01-02 03:04')
  })
})
