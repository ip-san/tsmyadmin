import { describe, expect, it } from 'vitest'
import { between, easeInOut, frameOf } from './camera.ts'

const boxes: Record<string, { x: number; y: number }> = {
  a: { x: 0, y: 0 },
  b: { x: 1000, y: 600 },
  c: { x: 100, y: 100 },
}
const at = (n: string) => boxes[n] ?? { x: 0, y: 0 }
const size = () => ({ width: 200, height: 100 })
const all = ['a', 'b', 'c']

describe('frameOf', () => {
  it('frames every table when none are named, with room around them', () => {
    expect(frameOf([], all, at, size)).toEqual({ x: -48, y: -48, width: 1296, height: 796 })
  })

  it('frames the tables named, kept no closer than the least frame and centred on them', () => {
    // a and c: 0..300 × 0..200, padded to -48..348 × -48..248, grown to 720 × 420 about the same middle.
    expect(frameOf(['a', 'c'], all, at, size)).toEqual({ x: -210, y: -110, width: 720, height: 420 })
  })

  it('leaves out names not drawn, and frames everything when none of them are', () => {
    expect(frameOf(['a', 'gone'], all, at, size, { width: 0, height: 0 })).toEqual({
      x: -48,
      y: -48,
      width: 296,
      height: 196,
    })
    expect(frameOf(['gone'], all, at, size)).toEqual(frameOf([], all, at, size))
  })

  it('gives the least frame when there is nothing to draw', () => {
    expect(frameOf([], [], at, size)).toEqual({ x: 0, y: 0, width: 720, height: 420 })
  })
})

describe('between and easeInOut', () => {
  it('moves part of the way, slow at both ends', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    const b = { x: 100, y: 50, width: 300, height: 200 }
    expect(between(a, b, 0)).toEqual(a)
    expect(between(a, b, 1)).toEqual(b)
    expect(between(a, b, 0.5)).toEqual({ x: 50, y: 25, width: 200, height: 150 })
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.5)).toBe(0.5)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.1)).toBeLessThan(0.1)
    expect(easeInOut(0.9)).toBeGreaterThan(0.9)
  })
})
