import type { Cell } from '@tsmyadmin/shared'
import type { Ref } from 'react'
import { locale } from '@/config/locale.ts'
import { MAX_POINTS, niceScale, toNumber } from '@/lib/chart-data.ts'
import { type Pt, parseTime, polylinePath, timeLabel } from '@/lib/chart-shapes.ts'

const t = locale.sql.chart
const FILL = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4', 'fill-chart-5', 'fill-chart-6']
const STROKE = [
  'stroke-chart-1',
  'stroke-chart-2',
  'stroke-chart-3',
  'stroke-chart-4',
  'stroke-chart-5',
  'stroke-chart-6',
]
const WIDTH = 720
const HEIGHT = 280
const LEFT = 64
const TOP = 12
const BOTTOM = 32
const RIGHT = 16

/** A position on the horizontal axis: a number (scatter plot) or a moment (timeline). */
const positionOf = (kind: 'scatter' | 'timeline', cell: Cell | undefined): number | null =>
  kind === 'scatter' ? toNumber(cell) : typeof cell === 'string' ? parseTime(cell) : null

/**
 * Points placed by two numbers (a scatter plot), or by a moment and a number (a timeline, whose points are also joined
 * in time order). Rows missing either are left out; the caption says how many.
 */
export function ChartXY({
  kind,
  rows,
  x,
  ys,
  names,
  svgRef,
}: {
  kind: 'scatter' | 'timeline'
  rows: readonly Cell[][]
  x: number
  ys: readonly number[]
  names: readonly string[]
  svgRef: Ref<SVGSVGElement>
}) {
  const series = ys.map((column) => {
    const points: Pt[] = []
    for (const row of rows.slice(0, MAX_POINTS)) {
      const at = positionOf(kind, row[x])
      const value = toNumber(row[column])
      if (at !== null && value !== null) points.push([at, value])
    }
    return { column, points: kind === 'timeline' ? points.sort((a, b) => a[0] - b[0]) : points }
  })
  const xs = series.flatMap((s) => s.points.map((p) => p[0]))
  const vs = series.flatMap((s) => s.points.map((p) => p[1]))
  if (xs.length === 0) return <p className="text-sm text-ink-sub">{t.noPoints}</p>
  const xScale = kind === 'scatter' ? niceScale(xs, 6, { includeZero: false }) : timeScale(xs)
  const yScale = niceScale(vs, 5, { includeZero: false })
  const left = Math.max(LEFT, 12 + 6 * Math.max(...yScale.ticks.map((tick) => tick.toLocaleString('ja-JP').length)))
  const plotW = WIDTH - left - RIGHT
  const plotH = HEIGHT - TOP - BOTTOM
  const px = (v: number) => left + ((v - xScale.min) / (xScale.max - xScale.min || 1)) * plotW
  const py = (v: number) => TOP + plotH - ((v - yScale.min) / (yScale.max - yScale.min || 1)) * plotH
  const span = xScale.max - xScale.min
  return (
    <figure className="overflow-x-auto">
      <figcaption className="sr-only">{t.caption(names[x] ?? '', ys.map((c) => names[c] ?? '').join(', '))}</figcaption>
      <svg ref={svgRef} width={WIDTH} height={HEIGHT} aria-hidden className="text-ink-sub">
        {yScale.ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={WIDTH - RIGHT} y1={py(tick)} y2={py(tick)} className="stroke-line" />
            <text x={left - 6} y={py(tick) + 4} textAnchor="end" className="fill-ink-sub text-[10px]">
              {tick.toLocaleString('ja-JP')}
            </text>
          </g>
        ))}
        {xScale.ticks.map((tick) => (
          <text
            key={tick}
            x={px(tick)}
            y={HEIGHT - BOTTOM + 16}
            textAnchor="middle"
            className="fill-ink-sub text-[10px]"
          >
            {kind === 'scatter' ? tick.toLocaleString('ja-JP') : timeLabel(tick, span)}
          </text>
        ))}
        <line x1={left} x2={WIDTH - RIGHT} y1={TOP + plotH} y2={TOP + plotH} className="stroke-line-strong" />
        {series.map((s, si) => (
          <g key={s.column} data-series={names[s.column]}>
            {kind === 'timeline' ? (
              <path
                d={polylinePath(s.points.map(([a, b]): Pt => [px(a), py(b)]))}
                className={`fill-none ${STROKE[si % STROKE.length]}`}
                strokeWidth={2}
              />
            ) : null}
            {s.points.map(([a, b], i) => (
              <circle key={i} cx={px(a)} cy={py(b)} r={3} className={FILL[si % FILL.length]} />
            ))}
          </g>
        ))}
      </svg>
    </figure>
  )
}

/** Five ticks over the range of moments (there is no round step in time worth the trouble here). */
function timeScale(values: readonly number[]): { min: number; max: number; ticks: number[] } {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return { min: min - 3_600_000, max: max + 3_600_000, ticks: [min] }
  return { min, max, ticks: Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4) }
}
