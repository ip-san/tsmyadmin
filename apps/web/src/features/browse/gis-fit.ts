import { bounds, type Shape } from './geometry.ts'

/** How many times wider than the typical shape one has to be to be left out of the frame. */
const OUTLIER_FACTOR = 30

const reach = (shape: Shape): number => {
  const box = bounds([shape])
  return box ? Math.max(box.maxX - box.minX, box.maxY - box.minY) : 0
}

/**
 * The shapes that would flatten all the others if the frame had to hold them — a whole-world rectangle among city
 * outlines shrinks every city to a dot. A shape counts when it is far wider than the typical one (the median), and
 * only where there are enough shapes to have a typical one.
 */
export function outlierIndexes(shapes: readonly Shape[]): number[] {
  if (shapes.length < 3) return []
  const sizes = shapes.map(reach)
  const sorted = [...sizes].filter((n) => n > 0).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (median === undefined || median <= 0) return []
  return sizes.flatMap((n, i) => (n > median * OUTLIER_FACTOR ? [i] : []))
}
