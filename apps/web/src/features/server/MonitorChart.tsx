import { locale } from '@/config/locale.ts'
import { niceScale } from '@/lib/chart-data.ts'

const STROKE = ['stroke-chart-1', 'stroke-chart-2', 'stroke-chart-3', 'stroke-chart-4']
const SWATCH = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4']
const WIDTH = 640
const HEIGHT = 180
const LEFT = 56
const RIGHT = 12
const TOP = 10
const BOTTOM = 22

export interface MonitorLine {
  label: string
  values: readonly (number | null)[]
}

/**
 * A line chart over the samples so far, newest at the right. The legend below gives the latest value of each line,
 * which is what the picture says for anyone not using it.
 */
export function MonitorChart({
  title,
  lines,
  times,
  format,
}: {
  title: string
  lines: readonly MonitorLine[]
  times: readonly number[]
  format: (value: number) => string
}) {
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== null))
  const scale = niceScale(all)
  const plotWidth = WIDTH - LEFT - RIGHT
  const plotHeight = HEIGHT - TOP - BOTTOM
  const x = (i: number) => LEFT + (times.length <= 1 ? plotWidth : (i / (times.length - 1)) * plotWidth)
  const y = (v: number) => TOP + plotHeight - ((v - scale.min) / (scale.max - scale.min)) * plotHeight
  const clock = (ms: number) => new Date(ms).toLocaleTimeString('ja-JP', { hour12: false })
  return (
    <figure className="rounded border border-line bg-surface p-3">
      <figcaption className="mb-1 text-sm font-medium text-ink">{title}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title} className="w-full max-w-3xl">
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className="stroke-line" />
            <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end" className="fill-ink-sub text-[10px]">
              {format(tick)}
            </text>
          </g>
        ))}
        {times.length > 0 ? (
          <>
            <text x={LEFT} y={HEIGHT - 6} className="fill-ink-sub text-[10px]">
              {clock(times[0] ?? 0)}
            </text>
            <text x={WIDTH - RIGHT} y={HEIGHT - 6} textAnchor="end" className="fill-ink-sub text-[10px]">
              {clock(times.at(-1) ?? 0)}
            </text>
          </>
        ) : null}
        {lines.map((line, s) => {
          // A gap (no value) breaks the line instead of drawing across it.
          const segments: string[] = []
          let current: string[] = []
          line.values.forEach((v, i) => {
            if (v === null) {
              if (current.length > 0) segments.push(current.join(' '))
              current = []
            } else current.push(`${x(i)},${y(v)}`)
          })
          if (current.length > 0) segments.push(current.join(' '))
          return segments.map((points) => (
            <polyline
              key={`${line.label}:${points.slice(0, 24)}`}
              points={points}
              fill="none"
              strokeWidth={1.75}
              className={STROKE[s % STROKE.length]}
            />
          ))
        })}
      </svg>
      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink">
        {lines.map((line, s) => {
          const latest = [...line.values].reverse().find((v): v is number => v !== null)
          return (
            <div key={line.label} className="flex items-center gap-1.5">
              <span aria-hidden className={`inline-block h-2 w-4 rounded-sm ${SWATCH[s % SWATCH.length]}`} />
              <dt className="text-ink-sub">{line.label}</dt>
              <dd className="tabular-nums">{latest === undefined ? locale.common.unknown : format(latest)}</dd>
            </div>
          )
        })}
      </dl>
    </figure>
  )
}
