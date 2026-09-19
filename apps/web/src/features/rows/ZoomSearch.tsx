import { useQuery } from '@tanstack/react-query'
import type { Filter } from '@tsmyadmin/shared'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { MAX_POINTS } from '@/lib/chart-data.ts'
import { structureQuery, type TableRef } from '@/lib/queries.ts'
import { type PickedPoint, ZoomPlot, type ZoomView } from './ZoomPlot.tsx'
import { plottableColumns, rangeFilters } from './zoom-rows.ts'

const t = locale.zoom

/** How many rows the plot may fetch; the browse API returns at most 1,000 at a time. */
const LIMITS = [100, MAX_POINTS, 1000]

interface Range {
  min: string
  max: string
}

/** One axis: its column and the range it is limited to. */
function AxisFields({
  id,
  label,
  axes,
  column,
  range,
  onColumn,
  onRange,
}: {
  id: string
  label: string
  axes: string[]
  column: string
  range: Range
  onColumn: (c: string) => void
  onRange: (r: Range) => void
}) {
  return (
    <fieldset className="flex flex-wrap items-end gap-2">
      <legend className="sr-only">{label}</legend>
      <Field id={id} label={label}>
        <Select id={id} value={column} onChange={(e) => onColumn(e.target.value)}>
          {axes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`${id}-min`} label={t.min(label)}>
        <Input
          id={`${id}-min`}
          type="number"
          step="any"
          value={range.min}
          onChange={(e) => onRange({ ...range, min: e.target.value })}
          className="w-28"
        />
      </Field>
      <Field id={`${id}-max`} label={t.max(label)}>
        <Input
          id={`${id}-max`}
          type="number"
          step="any"
          value={range.max}
          onChange={(e) => onRange({ ...range, max: e.target.value })}
          className="w-28"
        />
      </Field>
    </fieldset>
  )
}

/**
 * phpMyAdmin's "Zoom search": two numeric columns of the rows the search finds, as a scatter plot, each axis
 * optionally limited to a range. A point opens the row it stands for; a label column names the points.
 */
export function ZoomSearch({ tableRef, filters }: { tableRef: TableRef; filters: Filter[] }) {
  const id = useId()
  const structure = useQuery(structureQuery(tableRef))
  const columns = (structure.data?.columns ?? []).map((c) => c.name)
  const axes = plottableColumns(structure.data?.columns ?? [])
  const [chosenX, setX] = useState('')
  const [chosenY, setY] = useState('')
  const [xRange, setXRange] = useState<Range>({ min: '', max: '' })
  const [yRange, setYRange] = useState<Range>({ min: '', max: '' })
  const [label, setLabel] = useState('')
  const [limit, setLimit] = useState(MAX_POINTS)
  // The structure arrives after the first render: until a column is chosen, the selects show the defaults, and
  // the plot has to use the same ones rather than the empty initial state.
  const x = axes.includes(chosenX) ? chosenX : (axes[0] ?? '')
  const y = axes.includes(chosenY) ? chosenY : (axes[1] ?? axes[0] ?? '')
  const [shown, setShown] = useState<{ view: ZoomView; filters: Filter[] } | null>(null)
  const [picked, setPicked] = useState<PickedPoint | null>(null)
  if (axes.length === 0) return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setPicked(null)
    setShown({
      view: { x, y, label: columns.includes(label) ? label : '', limit },
      filters: [...filters, ...rangeFilters(x, xRange.min, xRange.max), ...rangeFilters(y, yRange.min, yRange.max)],
    })
  }
  return (
    <section className="mt-6 rounded border border-line p-3" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mb-1 text-sm font-semibold text-ink">
        {t.title}
      </h2>
      <p className="mb-2 text-xs text-ink-sub">{t.hint}</p>
      <form onSubmit={submit} className="space-y-2">
        <AxisFields
          id={`${id}-x`}
          label={t.x}
          axes={axes}
          column={x}
          range={xRange}
          onColumn={setX}
          onRange={setXRange}
        />
        <AxisFields
          id={`${id}-y`}
          label={t.y}
          axes={axes}
          column={y}
          range={yRange}
          onColumn={setY}
          onRange={setYRange}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${id}-label`} label={t.label}>
            <Select id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)}>
              <option value="">{t.noLabel}</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-limit`} label={t.limit}>
            <Select id={`${id}-limit`} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString('ja-JP')}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary">
            {t.plot}
          </Button>
        </div>
      </form>
      {shown ? (
        <ZoomPlot tableRef={tableRef} filters={shown.filters} view={shown.view} picked={picked} onPick={setPicked} />
      ) : null}
    </section>
  )
}
