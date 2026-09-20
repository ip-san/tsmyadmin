import { describe, expect, it } from 'vitest'
import { layoutLegend } from './chart-legend.ts'

describe('layoutLegend', () => {
  it('lays entries in a row and starts another when the width is used up', () => {
    const { items, height } = layoutLegend(['aaaa', 'bbbb', 'cccc'], 200)
    expect(items.map((i) => i.y)).toEqual([0, 0, 0])
    expect(height).toBe(18)
    const wrapped = layoutLegend(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'], 150)
    expect(wrapped.items.map((i) => i.y)).toEqual([0, 18, 36])
    expect(wrapped.height).toBe(54)
  })

  it('counts wide characters as wider, puts one per row when vertical, and is empty for no labels', () => {
    expect(layoutLegend(['あいうえお', 'かきくけこ'], 120).items.map((i) => i.y)).toEqual([0, 18])
    expect(layoutLegend(['a', 'b'], 500, { vertical: true }).items.map((i) => i.y)).toEqual([0, 18])
    expect(layoutLegend([], 100)).toEqual({ items: [], height: 0 })
  })
})
