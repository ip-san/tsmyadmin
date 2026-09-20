/** One legend entry with its place. */
export interface LegendItem {
  label: string
  x: number
  y: number
}

const SWATCH = 12
const GAP = 6
const ROW = 18
const AFTER = 14

/** The width a label takes at the chart's small text size: a wide (CJK) character is about twice a Latin one. */
const textWidth = (label: string) => Array.from(label).reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 11 : 6), 0)

/**
 * Places legend entries in rows that fill `width` before starting the next (or one per row when `vertical`), so the
 * legend can be drawn inside the chart's own SVG and travel with it when the chart is saved as a file.
 */
export function layoutLegend(
  labels: readonly string[],
  width: number,
  { vertical = false }: { vertical?: boolean } = {}
): { items: LegendItem[]; height: number } {
  const items: LegendItem[] = []
  let x = 0
  let row = 0
  for (const label of labels) {
    const w = SWATCH + GAP + textWidth(label) + AFTER
    if (!vertical && x > 0 && x + w > width) {
      x = 0
      row++
    }
    if (vertical && items.length > 0) row++
    items.push({ label, x, y: row * ROW })
    x += w
  }
  return { items, height: labels.length === 0 ? 0 : (row + 1) * ROW }
}
