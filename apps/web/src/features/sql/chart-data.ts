import type { Cell } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'

/** Points drawn at most; a longer result is charted from its first rows, and the chart says so. */
export const MAX_POINTS = 500

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/

/** A cell as a number, or null when it is NULL or not a number (BIGINT and DECIMAL arrive as digit strings). */
export function toNumber(cell: Cell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell !== 'string' || !NUMBER.test(cell.trim())) return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

/**
 * Columns that can be plotted: every non-NULL value is a number, and there is at least one. Decided by the values
 * rather than the declared type, which says nothing useful for an expression such as `COUNT(*)` on some servers.
 */
export function numericColumns(columnCount: number, rows: readonly Cell[][]): number[] {
  const out: number[] = []
  for (let c = 0; c < columnCount; c++) {
    let seen = false
    let numeric = true
    for (const row of rows) {
      const cell = row[c] ?? null
      if (cell === null) continue
      seen = true
      if (toNumber(cell) === null) {
        numeric = false
        break
      }
    }
    if (seen && numeric) out.push(c)
  }
  return out
}

/** A cell as an axis label. */
function labelOf(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (isTruncatedCell(cell)) return `${cell.$text}…`
  if (isBinaryCell(cell)) return cell.$bin
  return String(cell)
}

export interface Series {
  column: number
  /** One per label; null where the row has no number for this column (drawn as a gap). */
  values: (number | null)[]
}

export function chartData(rows: readonly Cell[][], x: number, ys: readonly number[]) {
  const shown = rows.slice(0, MAX_POINTS)
  return {
    labels: shown.map((row) => labelOf(row[x])),
    series: ys.map((column): Series => ({ column, values: shown.map((row) => toNumber(row[column])) })),
    clipped: rows.length > MAX_POINTS,
  }
}

/** Axis bounds and ticks at round steps (1, 2, 5 × 10ⁿ), always including zero so bars start from the axis. */
export function niceScale(values: readonly number[], tickCount = 5) {
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  if (lo === hi) return { min: 0, max: 1, ticks: [0, 1] }
  const rough = (hi - lo) / tickCount
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude
  const min = Math.floor(lo / step) * step
  const max = Math.ceil(hi / step) * step
  const ticks: number[] = []
  // Integer steps from min avoid accumulating float error (0.1 + 0.2).
  for (let i = 0; min + i * step <= max + step / 1e6; i++) ticks.push(Number((min + i * step).toPrecision(12)))
  return { min, max, ticks }
}
