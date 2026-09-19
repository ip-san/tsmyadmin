import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Cell, ColumnDef, Filter } from '@tsmyadmin/shared'
import { type FormEvent, useId, useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { MAX_POINTS, niceScale, scatterPoints } from '@/lib/chart-data.ts'
import { rowsQuery, structureQuery, type TableRef } from '@/lib/queries.ts'

const t = locale.zoom

/** A picked point: its row's position, in the rows fetched at `at`. */
interface PickedPoint {
  row: number
  at: number
}

const WIDTH = 640
const HEIGHT = 360
const LEFT = 72
const RIGHT = 16
const TOP = 12
const BOTTOM = 40

/** Columns declared as numbers: the axes of the plot. Bit and boolean columns are left out (two values only). */
export function plottableColumns(columns: Pick<ColumnDef, 'name' | 'dataType'>[]): string[] {
  return columns
    .filter(
      (c) => /int|decimal|numeric|float|double|real|serial/i.test(c.dataType) && !/interval|point/i.test(c.dataType)
    )
    .map((c) => c.name)
}

/** The filters that find exactly this row again, from its key columns; null when the table has no usable key. */
export function rowFilters(keyColumns: string[], columns: string[], row: readonly Cell[]): Filter[] | null {
  if (keyColumns.length === 0) return null
  const out: Filter[] = []
  for (const key of keyColumns) {
    const cell = row[columns.indexOf(key)]
    // A binary or cut-off key cannot be typed back into a filter.
    if (cell === undefined || cell === null || typeof cell === 'object') return null
    out.push({ column: key, op: 'eq', value: cell })
  }
  return out
}

/**
 * phpMyAdmin's "Zoom search": two numeric columns of the rows the search finds, as a scatter plot. A point opens
 * the row it stands for. The table below the plot lists the same points for anyone not using the picture.
 */
export function ZoomSearch({ tableRef, filters }: { tableRef: TableRef; filters: Filter[] }) {
  const id = useId()
  const structure = useQuery(structureQuery(tableRef))
  const axes = plottableColumns(structure.data?.columns ?? [])
  const [chosenX, setX] = useState('')
  const [chosenY, setY] = useState('')
  // The structure arrives after the first render: until a column is chosen, the selects show the defaults, and
  // the plot has to use the same ones rather than the empty initial state.
  const x = axes.includes(chosenX) ? chosenX : (axes[0] ?? '')
  const y = axes.includes(chosenY) ? chosenY : (axes[1] ?? axes[0] ?? '')
  const [shown, setShown] = useState<{ x: string; y: string } | null>(null)
  const [picked, setPicked] = useState<PickedPoint | null>(null)
  if (axes.length === 0) return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setPicked(null)
    setShown({ x, y })
  }
  return (
    <section className="mt-6 rounded border border-line p-3" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mb-1 text-sm font-semibold text-ink">
        {t.title}
      </h2>
      <p className="mb-2 text-xs text-ink-sub">{t.hint}</p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field id={`${id}-x`} label={t.x}>
          <Select id={`${id}-x`} value={x} onChange={(e) => setX(e.target.value)}>
            {axes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${id}-y`} label={t.y}>
          <Select id={`${id}-y`} value={y} onChange={(e) => setY(e.target.value)}>
            {axes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary">
          {t.plot}
        </Button>
      </form>
      {shown ? (
        <Plot tableRef={tableRef} filters={filters} x={shown.x} y={shown.y} picked={picked} onPick={setPicked} />
      ) : null}
    </section>
  )
}

function Plot({
  tableRef,
  filters,
  x,
  y,
  picked,
  onPick,
}: {
  tableRef: TableRef
  filters: Filter[]
  x: string
  y: string
  picked: PickedPoint | null
  onPick: (pick: PickedPoint) => void
}) {
  const rows = useQuery(rowsQuery(tableRef, { offset: 0, limit: MAX_POINTS, sort: [], filters }))
  if (rows.isPending) return <Spinner />
  if (rows.isError) return <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} />
  const names = rows.data.columns.map((c) => c.name)
  const { points, skipped } = scatterPoints(rows.data.rows, names.indexOf(x), names.indexOf(y))
  const sx = niceScale(
    points.map((p) => p.x),
    5,
    { includeZero: false }
  )
  const sy = niceScale(
    points.map((p) => p.y),
    5,
    { includeZero: false }
  )
  const px = (v: number) => LEFT + ((v - sx.min) / (sx.max - sx.min)) * (WIDTH - LEFT - RIGHT)
  const py = (v: number) => TOP + (1 - (v - sy.min) / (sy.max - sy.min)) * (HEIGHT - TOP - BOTTOM)
  const total = rows.data.total
  // A pick is a position in the rows it was made in. Once those are refetched (a statement in the docked console,
  // say), the same position may be another row: the pick lapses rather than silently pointing elsewhere.
  const current = picked !== null && picked.at === rows.dataUpdatedAt ? picked.row : null
  const row = current === null ? undefined : rows.data.rows[current]
  const target = row ? rowFilters(rows.data.keyKind === 'pk' ? rows.data.keyColumns : [], names, row) : null
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-ink-sub" aria-live="polite">
        {t.summary(points.length, skipped)}
        {total !== null && total > MAX_POINTS ? ` ${t.clipped(MAX_POINTS)}` : ''}
      </p>
      {points.length > 0 ? (
        <figure className="overflow-x-auto">
          <figcaption className="sr-only">{t.caption(x, y)}</figcaption>
          {/* Pointer only: every point is also a row of the table below, reachable by keyboard. */}
          <svg width={WIDTH} height={HEIGHT} aria-hidden className="text-ink-sub">
            {sx.ticks.map((tick) => (
              <g key={`x${tick}`}>
                <line x1={px(tick)} x2={px(tick)} y1={TOP} y2={HEIGHT - BOTTOM} className="stroke-line" />
                <text x={px(tick)} y={HEIGHT - BOTTOM + 14} textAnchor="middle" className="fill-ink-sub text-[10px]">
                  {tick.toLocaleString('ja-JP')}
                </text>
              </g>
            ))}
            {sy.ticks.map((tick) => (
              <g key={`y${tick}`}>
                <line x1={LEFT} x2={WIDTH - RIGHT} y1={py(tick)} y2={py(tick)} className="stroke-line" />
                <text x={LEFT - 6} y={py(tick) + 4} textAnchor="end" className="fill-ink-sub text-[10px]">
                  {tick.toLocaleString('ja-JP')}
                </text>
              </g>
            ))}
            <text x={(LEFT + WIDTH - RIGHT) / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-ink text-xs">
              {x}
            </text>
            <text
              transform={`translate(12 ${(TOP + HEIGHT - BOTTOM) / 2}) rotate(-90)`}
              textAnchor="middle"
              className="fill-ink text-xs"
            >
              {y}
            </text>
            {points.map((p) => (
              <circle
                key={p.row}
                data-row={p.row}
                cx={px(p.x)}
                cy={py(p.y)}
                r={p.row === current ? 6 : 4}
                className={
                  p.row === current
                    ? 'cursor-pointer fill-chart-2 stroke-ink'
                    : 'cursor-pointer fill-chart-1 opacity-80 hover:opacity-100'
                }
                onClick={() => onPick({ row: p.row, at: rows.dataUpdatedAt })}
              />
            ))}
          </svg>
        </figure>
      ) : null}
      {row ? (
        <div className="rounded border border-line bg-surface p-2" aria-live="polite">
          <h3 className="mb-1 text-xs font-semibold text-ink">{t.picked}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {names.map((n, i) => (
              <div key={n} className="contents">
                <dt className="font-mono text-ink-sub">{n}</dt>
                <dd className="text-ink">
                  <CellValue cell={row[i] ?? null} />
                </dd>
              </div>
            ))}
          </dl>
          {target ? (
            <Link
              to="/db/$db/table/$table"
              params={{ db: tableRef.db, table: tableRef.table }}
              search={{
                ...(tableRef.schema ? { schema: tableRef.schema } : {}),
                filters: JSON.stringify(target),
                page: 1,
              }}
              className="mt-2 inline-block text-sm text-blue-700 underline dark:text-blue-300"
            >
              {t.open}
            </Link>
          ) : (
            <p className="mt-2 text-xs text-ink-sub">{t.noKey}</p>
          )}
        </div>
      ) : null}
      {points.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-ink-sub">{t.asTable(points.length)}</summary>
          <Table aria-label={t.caption(x, y)} className="mt-1">
            <thead>
              <tr>
                <Th className="text-right">{x}</Th>
                <Th className="text-right">{y}</Th>
                <Th>
                  <span className="sr-only">{t.pick}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <Tr key={p.row}>
                  <Td className="text-right tabular-nums">{p.x.toLocaleString('ja-JP')}</Td>
                  <Td className="text-right tabular-nums">{p.y.toLocaleString('ja-JP')}</Td>
                  <Td>
                    <Button
                      size="sm"
                      aria-pressed={p.row === current}
                      aria-label={t.pickPoint(x, p.x, y, p.y)}
                      onClick={() => onPick({ row: p.row, at: rows.dataUpdatedAt })}
                    >
                      {t.pick}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </details>
      ) : null}
    </div>
  )
}
