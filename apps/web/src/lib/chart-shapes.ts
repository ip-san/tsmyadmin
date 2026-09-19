export type Pt = [number, number]

const fixed = (n: number) => Number(n.toFixed(2))

/** A smooth curve through one run of points (Catmull-Rom turned into cubic Béziers). */
function curve(p: readonly Pt[]): string {
  const first = p[0]
  if (!first) return ''
  let d = `M ${fixed(first[0])} ${fixed(first[1])} `
  for (let i = 0; i < p.length - 1; i++) {
    const p1 = p[i] as Pt
    const p2 = p[i + 1] as Pt
    const p0 = p[i - 1] ?? p1
    const p3 = p[i + 2] ?? p2
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C ${fixed(c1[0])} ${fixed(c1[1])} ${fixed(c2[0])} ${fixed(c2[1])} ${fixed(p2[0])} ${fixed(p2[1])} `
  }
  return d
}

/** The runs a series is made of: consecutive points, cut at every missing value (a gap is not joined across). */
function runs(points: readonly (Pt | null)[]): Pt[][] {
  const out: Pt[][] = []
  let current: Pt[] = []
  for (const p of points) {
    if (p === null) {
      if (current.length > 0) out.push(current)
      current = []
    } else current.push(p)
  }
  if (current.length > 0) out.push(current)
  return out
}

/** A smooth line through the points, lifting the pen over a missing value. */
export function splinePath(points: readonly (Pt | null)[]): string {
  return runs(points)
    .map((run) => curve(run))
    .join('')
    .trim()
}

/** A straight line through the points, lifting the pen over a missing value. */
export function polylinePath(points: readonly (Pt | null)[]): string {
  return runs(points)
    .map((run) => run.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fixed(p[0])} ${fixed(p[1])}`).join(' '))
    .join(' ')
}

/** The area between a line and the baseline `base` (a y position), one shape per run of points. */
export function areaPath(points: readonly (Pt | null)[], base: number): string {
  return runs(points)
    .map((run) => {
      const first = run[0] as Pt
      const last = run[run.length - 1] as Pt
      const line = run.map((p) => `L ${fixed(p[0])} ${fixed(p[1])}`).join(' ')
      return `M ${fixed(first[0])} ${fixed(base)} ${line} L ${fixed(last[0])} ${fixed(base)} Z`
    })
    .join(' ')
}

/** Each positive value's share of the circle, as angles from the top, clockwise. Zero, negative and missing ones get none. */
export function pieAngles(values: readonly (number | null)[]): { from: number; to: number; share: number }[] {
  const total = values.reduce<number>((n, v) => n + (v !== null && v > 0 ? v : 0), 0)
  let at = -Math.PI / 2
  return values.map((v) => {
    if (total === 0 || v === null || v <= 0) return { from: at, to: at, share: 0 }
    const span = (v / total) * Math.PI * 2
    const slice = { from: at, to: at + span, share: v / total }
    at += span
    return slice
  })
}

/** A pie slice from the centre. A slice that is the whole circle is drawn as two arcs (one arc cannot close on itself). */
export function slicePath(cx: number, cy: number, r: number, from: number, to: number): string {
  const point = (a: number): Pt => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  if (to - from >= Math.PI * 2 - 1e-6) {
    const [x0, y0] = point(from)
    const [x1, y1] = point(from + Math.PI)
    return `M ${fixed(x0)} ${fixed(y0)} A ${r} ${r} 0 1 1 ${fixed(x1)} ${fixed(y1)} A ${r} ${r} 0 1 1 ${fixed(x0)} ${fixed(y0)} Z`
  }
  const [x0, y0] = point(from)
  const [x1, y1] = point(to)
  const large = to - from > Math.PI ? 1 : 0
  return `M ${cx} ${cy} L ${fixed(x0)} ${fixed(y0)} A ${r} ${r} 0 ${large} 1 ${fixed(x1)} ${fixed(y1)} Z`
}

const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/

/**
 * A date or date-time as it comes from a server, as milliseconds. One without a zone is read as UTC (only a common
 * scale here); one with a zone (PostgreSQL's `+09`) keeps it. A day that the month does not have is refused.
 */
export function parseTime(text: string): number | null {
  const m = TIME.exec(text.trim())
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', s = '00', fraction = '', zone = 'Z'] = m
  const day = Number(d)
  if (day < 1 || day > new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate()) return null
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.length > 3 ? zone.slice(-2) : '00'}`
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${fraction}${offset}`)
  return Number.isNaN(ms) ? null : ms
}

/** A time on an axis: the date when the whole range spans days, the time of day too when it does not. */
export function timeLabel(ms: number, spanMs: number): string {
  const iso = new Date(ms).toISOString()
  return spanMs > 2 * 86_400_000 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}
