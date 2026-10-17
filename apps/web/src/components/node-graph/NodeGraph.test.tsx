import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { arrowRoute, NodeGraph, nodeWidth } from './NodeGraph.tsx'

const nodes = [
  { id: 'a', label: 'session 12', sublabel: 'app@shop', tone: 'focus' as const, badge: '3' },
  { id: 'b', label: 'session 15' },
  { id: 'c', label: 'session 18', tone: 'blocked' as const },
]
const arrows = [
  { from: 'b', to: 'a', label: 'orders (X)' },
  { from: 'c', to: 'b', tone: 'blocked' as const },
  { from: 'c', to: 'gone' },
]

describe('NodeGraph', () => {
  it('is one image named for what it shows, with every box and the arrows between drawn boxes', () => {
    const { container } = render(<NodeGraph nodes={nodes} arrows={arrows} label="Lock waits" />)
    expect(screen.getByRole('img', { name: 'Lock waits' })).toBeInTheDocument()
    expect(screen.getByText('session 12')).toBeInTheDocument()
    expect(screen.getByText('app@shop')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('orders (X)')).toBeInTheDocument()
    // The arrow to a box that is not drawn is left out.
    expect(container.querySelectorAll('path[marker-end]')).toHaveLength(2)
  })

  it('outlines toned boxes and arrows, and fades the rest only when asked', () => {
    const { container, rerender } = render(<NodeGraph nodes={nodes} arrows={arrows} label="g" />)
    expect(container.querySelectorAll('[data-tone="blocked"]')).toHaveLength(2)
    expect(container.querySelectorAll('.opacity-30')).toHaveLength(0)
    rerender(<NodeGraph nodes={nodes} arrows={arrows} label="g" fadeUntoned />)
    // Box b and the arrow b → a carry no tone.
    expect(container.querySelectorAll('g.opacity-30')).toHaveLength(2)
  })
})

describe('arrowRoute', () => {
  const box = (x: number, y = 0) => ({ x, y })

  it('runs from the facing sides: leftwards, rightwards', () => {
    expect(arrowRoute(box(300), 100, box(0), 100, false).d).toMatch(/^M 300 22 C .* 100 22$/)
    expect(arrowRoute(box(0), 100, box(300), 100, false).d).toMatch(/^M 100 22 C .* 300 22$/)
  })

  it('curves out to the right between boxes of one column, and loops on a box pointing at itself', () => {
    const same = arrowRoute(box(0, 0), 100, box(0, 100), 100, false)
    expect(same.d).toMatch(/^M 100 22 C .* 100 122$/)
    expect(same.mid.x).toBeGreaterThan(100)
    expect(arrowRoute(box(0), 100, box(0), 100, true).d).toMatch(/^M 100 14 C .* 100 30$/)
  })
})

describe('nodeWidth', () => {
  it('fits the longer line, within bounds', () => {
    expect(nodeWidth(undefined)).toBe(140)
    expect(nodeWidth({ id: 'x', label: 'a' })).toBe(140)
    expect(nodeWidth({ id: 'x', label: 'a'.repeat(200) })).toBe(320)
    expect(nodeWidth({ id: 'x', label: 'a', sublabel: 'b'.repeat(30) })).toBeGreaterThan(140)
  })
})
