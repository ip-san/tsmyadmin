import type { LegendItem } from '@/lib/chart-legend.ts'

const FILL = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4', 'fill-chart-5', 'fill-chart-6']

/** A legend drawn as part of the chart's SVG (so a saved SVG / PNG has it), at (x, y). */
export function ChartLegend({ items, x, y }: { items: readonly LegendItem[]; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {items.map((item, i) => (
        <g key={`${i}-${item.label}`} transform={`translate(${item.x} ${item.y})`}>
          <rect width={12} height={12} rx={2} className={FILL[i % FILL.length]} />
          <text x={18} y={10} className="fill-ink text-[11px]">
            {item.label}
          </text>
        </g>
      ))}
    </g>
  )
}
