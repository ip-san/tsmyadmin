import type { Ref } from 'react'
import { locale } from '@/config/locale.ts'
import { layoutLegend } from '@/lib/chart-legend.ts'
import { pieAngles, slicePath } from '@/lib/chart-shapes.ts'
import { ChartLegend } from './ChartLegend.tsx'

const t = locale.sql.chart
const FILL = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4', 'fill-chart-5', 'fill-chart-6']
const SIZE = 260
/** Room to the right of the pie for its legend. */
const LEGEND_WIDTH = 260
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
  const legend = layoutLegend(
    slices.map((s, i) => `${s.label} ${((angles[i]?.share ?? 0) * 100).toFixed(1)}%`),
    LEGEND_WIDTH,
    { vertical: true }
  )
  return (
    <figure className="overflow-x-auto">
      <svg
        ref={svgRef}
        width={SIZE + LEGEND_WIDTH}
        height={Math.max(SIZE, legend.height + 16)}
        aria-hidden
        className="text-ink-sub"
      >
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
        <ChartLegend items={legend.items} x={SIZE + 8} y={8} />
      </svg>
      {/* The same numbers for a screen reader (the legend above is part of the picture). */}
      <figcaption className="sr-only">
        <ul>
          {slices.map((s, i) => (
            <li key={`${i}-${s.label}`}>
              {s.label} {((angles[i]?.share ?? 0) * 100).toFixed(1)}%
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  )
}
