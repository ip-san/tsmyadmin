import type { ResultSet } from '@tsmyadmin/shared'
import { useId, useState } from 'react'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { chartData, MAX_POINTS, niceScale, numericColumns } from './chart-data.ts'

const t = locale.sql.chart
/**
 * Series colours in order (tokens in index.css, contrast-checked against the surface). Written out in full: Tailwind
 * only generates classes it finds as literal strings.
 */
const FILL = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4', 'fill-chart-5', 'fill-chart-6']
const STROKE = [
  'stroke-chart-1',
  'stroke-chart-2',
  'stroke-chart-3',
  'stroke-chart-4',
  'stroke-chart-5',
  'stroke-chart-6',
]
const MAX_SERIES = FILL.length
const HEIGHT = 280
const LEFT = 64
const TOP = 12
const BOTTOM = 72
const MIN_STEP = 18

/**
 * phpMyAdmin's "Display chart" for one result set, as bars or lines: one column for the categories, up to six
 * numeric columns as series. Drawn from the rows on screen (the first MAX_POINTS of them); the table above holds
 * the same numbers for anyone not using the picture.
 */
export function ResultChart({ result }: { result: ResultSet }) {
  const id = useId()
  const names = result.columns.map((c) => c.name)
  const numeric = numericColumns(names.length, result.rows)
  // Defaults: the first non-numeric column as categories (or the first column), the first numeric one plotted.
  const firstText = names.findIndex((_, i) => !numeric.includes(i))
  const [kind, setKind] = useState<'bar' | 'line'>('bar')
  const [x, setX] = useState(firstText === -1 ? 0 : firstText)
  const [ys, setYs] = useState<number[]>(() => numeric.filter((c) => c !== x).slice(0, 1))

  if (numeric.length === 0) return <p className="text-sm text-ink-sub">{t.noNumbers}</p>
  const plotted = ys.filter((c) => c !== x)
  const { labels, series, clipped } = chartData(result.rows, x, plotted)
  const scale = niceScale(series.flatMap((s) => s.values.filter((v): v is number => v !== null)))
  const step = Math.max(MIN_STEP, Math.min(64, 720 / Math.max(labels.length, 1)))
  const width = LEFT + labels.length * step + 16
  const plotHeight = HEIGHT - TOP - BOTTOM
  const y = (v: number) => TOP + plotHeight - ((v - scale.min) / (scale.max - scale.min)) * plotHeight
  const labelEvery = Math.ceil(labels.length / 60)
  const barWidth = (step * 0.8) / Math.max(series.length, 1)

  return (
    <div className="space-y-2 rounded border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <Field id={`${id}-kind`} label={t.kind}>
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value === 'line' ? 'line' : 'bar')}
            className="w-32"
          >
            <option value="bar">{t.bar}</option>
            <option value="line">{t.line}</option>
          </Select>
        </Field>
        <Field id={`${id}-x`} label={t.x}>
          <Select id={`${id}-x`} value={x} onChange={(e) => setX(Number(e.target.value))} className="w-48">
            {names.map((n, i) => (
              <option key={`${n}-${i}`} value={i}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <legend className="mb-1 text-xs font-medium text-ink-sub">{t.y}</legend>
          {numeric.map((c) => (
            <label key={c} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={ys.includes(c)}
                disabled={c === x || (!ys.includes(c) && plotted.length >= MAX_SERIES)}
                onChange={(e) => setYs((prev) => (e.target.checked ? [...prev, c] : prev.filter((v) => v !== c)))}
              />
              {names[c]}
            </label>
          ))}
        </fieldset>
      </div>
      {clipped ? <p className="text-xs text-ink-sub">{t.clipped(MAX_POINTS)}</p> : null}
      {series.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.chooseSeries}</p>
      ) : (
        <figure className="overflow-x-auto">
          <figcaption className="mb-1 flex flex-wrap gap-3 text-xs text-ink">
            <span className="sr-only">{t.caption(names[x] ?? '', plotted.map((c) => names[c] ?? '').join(', '))}</span>
            {series.map((s, i) => (
              <span key={s.column} className="flex items-center gap-1" aria-hidden>
                <svg width={12} height={12} className={FILL[i]}>
                  <rect width={12} height={12} rx={2} />
                </svg>
                {names[s.column]}
              </span>
            ))}
          </figcaption>
          <svg width={width} height={HEIGHT} aria-hidden className="text-ink-sub">
            {scale.ticks.map((tick) => (
              <g key={tick}>
                <line x1={LEFT} x2={width - 8} y1={y(tick)} y2={y(tick)} className="stroke-line" />
                <text x={LEFT - 6} y={y(tick) + 4} textAnchor="end" className="fill-ink-sub text-[10px]">
                  {tick.toLocaleString('ja-JP')}
                </text>
              </g>
            ))}
            <line x1={LEFT} x2={width - 8} y1={y(0)} y2={y(0)} className="stroke-line-strong" />
            {labels.map((label, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={i}
                  transform={`translate(${LEFT + i * step + step / 2} ${HEIGHT - BOTTOM + 12}) rotate(-45)`}
                  textAnchor="end"
                  className="fill-ink-sub text-[10px]"
                >
                  {label.length > 16 ? `${label.slice(0, 15)}…` : label}
                </text>
              ) : null
            )}
            {series.map((s, si) =>
              kind === 'bar' ? (
                <g key={s.column} className={FILL[si]}>
                  {s.values.map((v, i) =>
                    v === null ? null : (
                      <rect
                        key={i}
                        data-series={names[s.column]}
                        x={LEFT + i * step + step * 0.1 + si * barWidth}
                        y={Math.min(y(v), y(0))}
                        width={Math.max(barWidth - 1, 1)}
                        height={Math.abs(y(0) - y(v))}
                      />
                    )
                  )}
                </g>
              ) : (
                <path
                  key={s.column}
                  data-series={names[s.column]}
                  d={linePath(s.values, (i) => LEFT + i * step + step / 2, y)}
                  className={`fill-none ${STROKE[si]}`}
                  strokeWidth={2}
                />
              )
            )}
          </svg>
        </figure>
      )}
    </div>
  )
}

/** A line through the points, lifting the pen over a missing value instead of joining across it. */
function linePath(values: readonly (number | null)[], px: (i: number) => number, py: (v: number) => number): string {
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v === null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'} ${px(i)} ${py(v)} `
    pen = true
  })
  return d.trim()
}
