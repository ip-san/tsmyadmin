import type { KeyboardEvent, PointerEvent } from 'react'
import { useRef } from 'react'
import { GRID, type Point, snapToGrid } from './layout.ts'

const STEP = 10
const BIG_STEP = 50
/** Pointer travel below this is a click with an unsteady hand, not a drag. */
const DRAG_THRESHOLD = 4

/**
 * Moving a diagram's boxes: by dragging, or with the arrow keys once focused (Shift for larger steps). `onMove`'s
 * `commit` is true for the move that ends one, which is when the page saves the layout.
 */
export function useBoxDrag({
  at,
  snap,
  onMove,
  onGrab,
}: {
  at: (table: string) => Point
  snap: boolean
  onMove: ((table: string, to: Point, commit: boolean) => void) | undefined
  /** The box taken hold of. */
  onGrab: (table: string) => void
}) {
  /** Where in the box it was grabbed, and where it was last put. */
  const drag = useRef<{ table: string; dx: number; dy: number; start: Point; last: Point; moved: boolean } | null>(null)
  // Dragged boxes land on the grid when snapping is on.
  const clamp = (p: Point): Point => {
    const kept = { x: Math.max(0, p.x), y: Math.max(0, p.y) }
    return snap ? snapToGrid(kept) : kept
  }

  // In diagram coordinates, measured against the SVG each time, so scrolling the diagram mid-drag does not jump the box.
  const pointerAt = (e: PointerEvent<SVGGElement>): Point => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }
  const startDrag = (table: string) => (e: PointerEvent<SVGGElement>) => {
    // Safari does not focus an SVG group on a click, so the pick is taken here as well as on focus.
    onGrab(table)
    const p = at(table)
    const pointer = pointerAt(e)
    drag.current = { table, dx: pointer.x - p.x, dy: pointer.y - p.y, start: pointer, last: p, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current
    if (!d) return
    const pointer = pointerAt(e)
    if (!d.moved && Math.hypot(pointer.x - d.start.x, pointer.y - d.start.y) < DRAG_THRESHOLD) return
    d.last = clamp({ x: pointer.x - d.dx, y: pointer.y - d.dy })
    d.moved = true
    onMove?.(d.table, d.last, false)
  }
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    // A click only focuses the box: saving its position would take it out of the automatic layout.
    if (d.moved) onMove?.(d.table, d.last, true)
  }
  const nudge = (table: string) => (e: KeyboardEvent<SVGGElement>) => {
    // On the grid the small step is a whole cell: half a cell would round back to where the box was.
    const step = e.shiftKey ? BIG_STEP : snap ? GRID : STEP
    const delta: Partial<Record<string, Point>> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    const p = at(table)
    onMove?.(table, clamp({ x: p.x + d.x, y: p.y + d.y }), true)
  }

  return { startDrag, moveDrag, endDrag, nudge }
}
