import type { Ref } from 'react'
import { locale } from '@/config/locale.ts'
import { pieAngles, slicePath } from '@/lib/chart-shapes.ts'

const t = locale.sql.chart
const FILL = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4', 'fill-chart-5', 'fill-chart-6']
const SIZE = 260
/** Slices drawn on their own; the smaller ones together are "other" (a pie of hundreds of slivers says nothing). */
const MAX_SLICES = 11

/** One numeric column as shares of a circle, a slice per row (the labels beside it read the same on a screen reader). */
export function ChartPie({
  labels,
  values,
  svgRef,
}: {
  labels: readonly string[]
  values: readonly (number | null)[]
  svgRef: Ref<SVGSVGElement>
}) {
  const ranked = values
    .map((v, i) => ({ label: labels[i] ?? '', value: v !== null && v > 0 ? v : 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
  const head = ranked.slice(0, MAX_SLICES)
  const rest = ranked.slice(MAX_SLICES).reduce((n, s) => n + s.value, 0)
  const slices = rest > 0 ? [...head, { label: t.other, value: rest }] : head
  if (slices.length === 0) return <p className="text-sm text-ink-sub">{t.noPositive}</p>
  const angles = pieAngles(slices.map((s) => s.value))
  const r = SIZE / 2 - 8
  return (
    <figure className="flex flex-wrap items-center gap-6">
      <svg ref={svgRef} width={SIZE} height={SIZE} aria-hidden className="text-ink-sub">
        {slices.map((s, i) => {
          const a = angles[i]
          return a ? (
            <path
              key={`${i}-${s.label}`}
              d={slicePath(SIZE / 2, SIZE / 2, r, a.from, a.to)}
              className={`${FILL[i % FILL.length]} stroke-surface`}
              strokeWidth={1}
            />
          ) : null
        })}
      </svg>
      <figcaption>
        <ul className="space-y-1 text-xs text-ink">
          {slices.map((s, i) => (
            <li key={`${i}-${s.label}`} className="flex items-center gap-2">
              <svg width={12} height={12} aria-hidden className={FILL[i % FILL.length]}>
                <rect width={12} height={12} rx={2} />
              </svg>
              <span>{s.label}</span>
              <span className="tabular-nums text-ink-sub">{((angles[i]?.share ?? 0) * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  )
}
