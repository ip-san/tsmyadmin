import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Filter } from '@tsmyadmin/shared'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale, numberLocale } from '@/config/locale.ts'
import { niceScale, scatterPoints } from '@/lib/chart-data.ts'
import { cellToText } from '@/lib/format.ts'
import { rowsQuery, type TableRef } from '@/lib/queries.ts'
import { rowFilters } from './zoom-rows.ts'

const t = locale.zoom

/** A picked point: its row's position, in the rows fetched at `at`. */
export interface PickedPoint {
  row: number
  at: number
}

const WIDTH = 640
const HEIGHT = 360
const LEFT = 72
const RIGHT = 16
const TOP = 12
const BOTTOM = 40

/** What to draw: the axes, the column that labels a point (empty for none) and how many rows at most. */
export interface ZoomView {
  x: string
  y: string
  label: string
  limit: number
}

/** The scatter plot of the matching rows, the picked row, and the same points as a table for the keyboard. */
export function ZoomPlot({
  tableRef,
  filters,
  view,
  picked,
  onPick,
}: {
  tableRef: TableRef
  filters: Filter[]
  view: ZoomView
  picked: PickedPoint | null
  onPick: (pick: PickedPoint) => void
}) {
  const { x, y, limit } = view
  const rows = useQuery(rowsQuery(tableRef, { offset: 0, limit, sort: [], filters }))
  if (rows.isPending) return <Spinner />
  if (rows.isError) return <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} />
  const names = rows.data.columns.map((c) => c.name)
  const { points, skipped } = scatterPoints(rows.data.rows, names.indexOf(x), names.indexOf(y), limit)
  const labelAt = view.label ? names.indexOf(view.label) : -1
  const labelOf = (row: number) => {
    const cell = labelAt < 0 ? undefined : rows.data.rows[row]?.[labelAt]
    return cell === undefined ? '' : cellToText(cell)
  }
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
        {total !== null && total > limit ? ` ${t.clipped(limit)}` : ''}
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
                  {tick.toLocaleString(numberLocale)}
                </text>
              </g>
            ))}
            {sy.ticks.map((tick) => (
              <g key={`y${tick}`}>
                <line x1={LEFT} x2={WIDTH - RIGHT} y1={py(tick)} y2={py(tick)} className="stroke-line" />
                <text x={LEFT - 6} y={py(tick) + 4} textAnchor="end" className="fill-ink-sub text-[10px]">
                  {tick.toLocaleString(numberLocale)}
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
              >
                {labelAt >= 0 ? <title>{labelOf(p.row)}</title> : null}
              </circle>
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
                {labelAt >= 0 ? <Th>{view.label}</Th> : null}
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
                  {labelAt >= 0 ? <Td>{labelOf(p.row)}</Td> : null}
                  <Td className="text-right tabular-nums">{p.x.toLocaleString(numberLocale)}</Td>
                  <Td className="text-right tabular-nums">{p.y.toLocaleString(numberLocale)}</Td>
                  <Td>
                    <Button
                      size="sm"
                      aria-pressed={p.row === current}
                      aria-label={
                        labelAt >= 0 ? `${labelOf(p.row)}: ${t.pickPoint(x, p.x, y, p.y)}` : t.pickPoint(x, p.x, y, p.y)
                      }
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
