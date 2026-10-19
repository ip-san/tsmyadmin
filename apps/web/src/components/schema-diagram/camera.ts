import type { Point } from './layout.ts'

/** A box on the diagram: where it is and how big. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the camera looks to show `tables` (every table when none): around their boxes with room to spare, and never
 * closer than `least` (two boxes are not blown up to fill a projector), keeping its middle on theirs.
 */
export function frameOf(
  tables: readonly string[],
  all: readonly string[],
  at: (table: string) => Point,
  size: (table: string) => { width: number; height: number },
  least: { width: number; height: number } = MIN_FRAME
): Rect {
  const shown = tables.length > 0 ? tables.filter((x) => all.includes(x)) : all
  const boxes = (shown.length > 0 ? shown : all).map((x) => ({ ...at(x), ...size(x) }))
  if (boxes.length === 0) return { x: 0, y: 0, ...least }
  const left = Math.min(...boxes.map((b) => b.x)) - FRAME_PAD
  // Room above for a box's badge, which sits over its top edge.
  const top = Math.min(...boxes.map((b) => b.y)) - FRAME_PAD
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + FRAME_PAD
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + FRAME_PAD
  const width = Math.max(right - left, least.width)
  const height = Math.max(bottom - top, least.height)
  return { x: (left + right - width) / 2, y: (top + bottom - height) / 2, width, height }
}

const FRAME_PAD = 48
const MIN_FRAME = { width: 720, height: 420 }

/** A frame part of the way from `a` to `b` (0 is `a`, 1 is `b`). */
export const between = (a: Rect, b: Rect, k: number): Rect => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
  width: a.width + (b.width - a.width) * k,
  height: a.height + (b.height - a.height) * k,
})

/** Slow at both ends, as a camera moves. */
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
