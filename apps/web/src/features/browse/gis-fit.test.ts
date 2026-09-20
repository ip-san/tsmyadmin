import { describe, expect, it } from 'vitest'
import type { Shape } from './geometry.ts'
import { outlierIndexes } from './gis-fit.ts'

const square = (x: number, y: number, size: number): Shape => ({
  type: 'polygon',
  rings: [
    [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ],
  ],
})

describe('outlierIndexes', () => {
  it('leaves out a shape that would shrink all the others to dots', () => {
    const world = square(-180, -90, 180)
    const towns = [0, 1, 2, 3].map((i) => square(127 + i * 0.3, 26, 0.2))
    expect(outlierIndexes([world, ...towns])).toEqual([0])
  })

  it('keeps shapes of ordinary spread, and never judges a handful', () => {
    expect(outlierIndexes([square(0, 0, 1), square(5, 5, 4), square(9, 1, 2), square(2, 8, 6)])).toEqual([])
    expect(outlierIndexes([square(-180, -90, 180), square(127, 26, 0.2)])).toEqual([])
  })

  it('has no typical size when every shape is a point', () => {
    const points: Shape[] = [0, 1, 2, 3].map((i) => ({ type: 'point', at: [i, i] }))
    expect(outlierIndexes(points)).toEqual([])
  })
})
