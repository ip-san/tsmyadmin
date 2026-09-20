import type { ResultSet } from '@tsmyadmin/shared'
import { useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { chartData, MAX_POINTS, niceScale, numericColumns } from '@/lib/chart-data.ts'
import { layoutLegend } from '@/lib/chart-legend.ts'
import { areaPath, type Pt, parseTime, polylinePath, splinePath } from '@/lib/chart-shapes.ts'
import { downloadBlob, downloadText, safeFilename } from '@/lib/download.ts'
import { standaloneSvg } from '@/lib/svg-export.ts'
import { svgToPng } from '@/lib/svg-png.ts'
import { ChartLegend } from './ChartLegend.tsx'
import { ChartPie } from './ChartPie.tsx'
import { ChartXY } from './ChartXY.tsx'

const KINDS = ['bar', 'line', 'spline', 'area', 'pie', 'scatter', 'timeline'] as const
type Kind = (typeof KINDS)[number]

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
const BOTTOM = 96
/** Characters of a category label shown; wide (CJK) text at this length still fits under the axis when rotated. */
const LABEL_CHARS = 10
const MIN_STEP = 18

/**
 * phpMyAdmin's "Display chart" for one result set, as bars or lines: one column for the categories, up to six
 * numeric columns as series. Drawn from the rows on screen (the first MAX_POINTS of them); the table above holds
 * the same numbers for anyone not using the picture.
 */
export function ResultChart({ result }: { result: ResultSet }) {
  const id = useId()
  const names = result.columns.map((c) => c.name)
  // One scan of the rows per result, not per toggle of a control.
  const numeric = useMemo(() => numericColumns(result.columns.length, result.rows), [result])
  // Defaults: the first non-numeric column as categories (or the first column), the first numeric one plotted.
  const firstText = names.findIndex((_, i) => !numeric.includes(i))
  const [kind, setKind] = useState<Kind>('bar')
  const [x, setX] = useState(firstText === -1 ? 0 : firstText)
  const svgRef = useRef<SVGSVGElement>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  // A timeline needs a column of dates; a scatter plot, one of numbers. The other kinds take any column as categories.
  const dates = useMemo(
    () =>
      names.flatMap((_, i) =>
        result.rows.some((r) => r[i] !== null && r[i] !== undefined) &&
        result.rows.every((r) => r[i] === null || (typeof r[i] === 'string' && parseTime(r[i] as string) !== null))
          ? [i]
          : []
      ),
    [result, names]
  )
  const [ys, setYs] = useState<number[]>(() => numeric.filter((c) => c !== x).slice(0, 1))

  if (numeric.length === 0) return <p className="text-sm text-ink-sub">{t.noNumbers}</p>
  const xChoices = kind === 'scatter' ? numeric : kind === 'timeline' ? dates : names.map((_, i) => i)
  const xNow = xChoices.includes(x) ? x : (xChoices[0] ?? x)
  const plotted = ys.filter((c) => c !== xNow)
  const { labels, series, clipped } = chartData(result.rows, xNow, plotted)
  const scale = niceScale(series.flatMap((s) => s.values.filter((v): v is number => v !== null)))
  const step = Math.max(MIN_STEP, Math.min(64, 720 / Math.max(labels.length, 1)))
  // Room for the widest tick label (large sums print many digits).
  const left = Math.max(LEFT, 12 + 6 * Math.max(...scale.ticks.map((tick) => tick.toLocaleString(numberLocale).length)))
  const width = left + labels.length * step + 16
  const plotHeight = HEIGHT - TOP - BOTTOM
  const y = (v: number) => TOP + plotHeight - ((v - scale.min) / (scale.max - scale.min)) * plotHeight
  const labelEvery = Math.ceil(labels.length / 60)
  const barWidth = (step * 0.8) / Math.max(series.length, 1)
  const at = (i: number) => left + i * step + step / 2
  // Inside the SVG, under the plot, so a saved file carries it.
  const legend = layoutLegend(
    series.map((s) => names[s.column] ?? ''),
    Math.max(width - left, 200)
  )
  const pointsOf = (values: readonly (number | null)[]): (Pt | null)[] =>
    values.map((v, i) => (v === null ? null : ([at(i), y(v)] as Pt)))
  const file = (extension: string) => safeFilename(`${names[xNow] ?? 'chart'}_${kind}`, extension)
  const save = async (format: 'svg' | 'png') => {
    const svg = svgRef.current
    if (!svg) return setSaveFailed(true)
    const { text, width: w, height: h } = standaloneSvg(svg, pageBackground())
    if (format === 'svg') return downloadText(file('svg'), text, 'image/svg+xml')
    try {
      setSaveFailed(false)
      downloadBlob(file('png'), await svgToPng(text, w, h))
    } catch {
      setSaveFailed(true)
    }
  }
  const categorical = kind === 'bar' || kind === 'line' || kind === 'spline' || kind === 'area'
  const drawable = series.length > 0 && (kind !== 'scatter' && kind !== 'timeline' ? true : xChoices.length > 0)

  return (
    <div className="space-y-2 rounded border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <Field id={`${id}-kind`} label={t.kind}>
          <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="w-36">
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t.kinds[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-x`} label={kind === 'scatter' || kind === 'timeline' ? t.xAxis : t.x}>
          <Select id={`${id}-x`} value={xNow} onChange={(e) => setX(Number(e.target.value))} className="w-48">
            {xChoices.map((i) => (
              <option key={`${names[i]}-${i}`} value={i}>
                {names[i]}
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
                disabled={c === xNow || (!ys.includes(c) && plotted.length >= MAX_SERIES)}
                onChange={(e) => setYs((prev) => (e.target.checked ? [...prev, c] : prev.filter((v) => v !== c)))}
              />
              {names[c]}
            </label>
          ))}
        </fieldset>
        {drawable ? (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save('svg')}>
              {t.saveSvg}
            </Button>
            <Button size="sm" onClick={() => void save('png')}>
              {t.savePng}
            </Button>
          </div>
        ) : null}
      </div>
      {saveFailed ? (
        <p role="alert" className="text-xs text-red-800 dark:text-red-200">
          {t.saveFailed}
        </p>
      ) : null}
      {kind === 'pie' ? <p className="text-xs text-ink-sub">{t.pieNote}</p> : null}
      {clipped ? <p className="text-xs text-ink-sub">{t.clipped(MAX_POINTS)}</p> : null}
      {xChoices.length === 0 ? (
        <p className="text-sm text-ink-sub">{kind === 'timeline' ? t.noDates : t.noNumbers}</p>
      ) : series.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.chooseSeries}</p>
      ) : kind === 'pie' ? (
        <ChartPie labels={labels} values={series[0]?.values ?? []} svgRef={svgRef} />
      ) : kind === 'scatter' || kind === 'timeline' ? (
        <ChartXY kind={kind} rows={result.rows} x={xNow} ys={plotted} names={names} svgRef={svgRef} />
      ) : categorical ? (
        <figure className="overflow-x-auto">
          <figcaption className="sr-only">
            {t.caption(names[xNow] ?? '', plotted.map((c) => names[c] ?? '').join(', '))}
          </figcaption>
          <svg ref={svgRef} width={width} height={HEIGHT + legend.height} aria-hidden className="text-ink-sub">
            {scale.ticks.map((tick) => (
              <g key={tick}>
                <line x1={left} x2={width - 8} y1={y(tick)} y2={y(tick)} className="stroke-line" />
                <text x={left - 6} y={y(tick) + 4} textAnchor="end" className="fill-ink-sub text-[10px]">
                  {tick.toLocaleString(numberLocale)}
                </text>
              </g>
            ))}
            <line x1={left} x2={width - 8} y1={y(0)} y2={y(0)} className="stroke-line-strong" />
            {labels.map((label, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={i}
                  transform={`translate(${left + i * step + step / 2} ${HEIGHT - BOTTOM + 12}) rotate(-45)`}
                  textAnchor="end"
                  className="fill-ink-sub text-[10px]"
                >
                  {short(label)}
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
                        x={left + i * step + step * 0.1 + si * barWidth}
                        y={Math.min(y(v), y(0))}
                        width={Math.max(barWidth - 1, 1)}
                        height={Math.abs(y(0) - y(v))}
                      />
                    )
                  )}
                </g>
              ) : (
                <g key={s.column}>
                  {kind === 'area' ? (
                    <path d={areaPath(pointsOf(s.values), y(0))} className={FILL[si]} fillOpacity={0.25} />
                  ) : null}
                  <path
                    data-series={names[s.column]}
                    d={kind === 'spline' ? splinePath(pointsOf(s.values)) : polylinePath(pointsOf(s.values))}
                    className={`fill-none ${STROKE[si]}`}
                    strokeWidth={2}
                  />
                </g>
              )
            )}
            <ChartLegend items={legend.items} x={left} y={HEIGHT} />
          </svg>
        </figure>
      ) : null}
    </div>
  )
}

/** A category label cut to LABEL_CHARS characters (by code point, so no surrogate pair is split). */
function short(label: string): string {
  const chars = Array.from(label)
  return chars.length > LABEL_CHARS ? `${chars.slice(0, LABEL_CHARS - 1).join('')}…` : label
}

/** The page's own background, so a saved chart reads the same as on screen (a transparent body falls back on the theme). */
function pageBackground(): string {
  const set = getComputedStyle(document.body).backgroundColor
  if (set && set !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(set)) return set
  return document.documentElement.classList.contains('dark') ? '#18181b' : '#ffffff'
}
