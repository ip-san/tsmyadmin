import { useQuery } from '@tanstack/react-query'
import type { BrowseOptions, Cell } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'
import { useId, useState } from 'react'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { rowsQuery, sessionQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { bounds, parseShape, type Shape, spatialEncoding } from './geometry.ts'

const t = locale.gis
const WIDTH = 640
const HEIGHT = 400
const PAD = 16

type Project = (p: [number, number]) => [number, number]

function ShapePath({ shape, project, scale }: { shape: Shape; project: Project; scale: number }) {
  switch (shape.type) {
    case 'point': {
      const [x, y] = project(shape.at)
      return <circle cx={x} cy={y} r={4} className="fill-chart-1" />
    }
    case 'circle': {
      const [x, y] = project(shape.at)
      return <circle cx={x} cy={y} r={Math.max(shape.r * scale, 1)} className="fill-chart-1/20 stroke-chart-1" />
    }
    case 'line':
      return (
        <path
          d={shape.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${project(p).join(' ')}`).join(' ')}
          className="fill-none stroke-chart-1"
          strokeWidth={2}
        />
      )
    case 'polygon':
      return (
        <path
          d={shape.rings
            .map((ring) => `${ring.map((p, i) => `${i === 0 ? 'M' : 'L'} ${project(p).join(' ')}`).join(' ')} Z`)
            .join(' ')}
          fillRule="evenodd"
          className="fill-chart-1/20 stroke-chart-1"
        />
      )
    default:
      return (
        <>
          {shape.parts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one value, in their stored order
            <ShapePath key={i} shape={part} project={project} scale={scale} />
          ))}
        </>
      )
  }
}

function labelOf(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (isTruncatedCell(cell)) return cell.$text
  if (isBinaryCell(cell)) return ''
  return String(cell)
}

/**
 * phpMyAdmin's "Visualize GIS data" for the page of rows on screen: the shapes of one spatial column, drawn to
 * scale in their own coordinates. A picture of the shapes, not a map — there are no tiles behind it, so nothing
 * leaves the browser. Hovering a shape shows the label column's value.
 */
export function GisView({ tableRef, options }: { tableRef: TableRef; options: BrowseOptions }) {
  const id = useId()
  const dialect = useQuery(sessionQuery).data?.dialect
  const structure = useQuery(structureQuery(tableRef))
  const rows = useQuery(rowsQuery(tableRef, options))
  const [chosen, setChosen] = useState('')
  const [label, setLabel] = useState('')
  const spatial = (structure.data?.columns ?? []).flatMap((c) => {
    const encoding = dialect ? spatialEncoding(dialect, c.dataType) : null
    return encoding ? [{ name: c.name, encoding }] : []
  })
  if (spatial.length === 0 || !rows.data) return null
  const column = spatial.find((c) => c.name === chosen) ?? spatial[0]
  if (!column) return null
  const names = rows.data.columns.map((c) => c.name)
  const at = names.indexOf(column.name)
  const labelAt = names.indexOf(label)
  const drawn: { shape: Shape; label: string; row: number }[] = []
  let unreadable = 0
  rows.data.rows.forEach((row, i) => {
    const cell = row[at] ?? null
    if (cell === null) return
    const shape = parseShape(column.encoding, cell)
    if (shape) drawn.push({ shape, label: labelAt === -1 ? '' : labelOf(row[labelAt]), row: i })
    else unreadable++
  })
  const box = bounds(drawn.map((d) => d.shape))
  // One scale for both axes, so a square stays square; a single point gets a unit box around it.
  const spanX = box ? Math.max(box.maxX - box.minX, 1e-9) : 1
  const spanY = box ? Math.max(box.maxY - box.minY, 1e-9) : 1
  const scale =
    box && (spanX > 1e-9 || spanY > 1e-9) ? Math.min((WIDTH - 2 * PAD) / spanX, (HEIGHT - 2 * PAD) / spanY) : 1
  const cx = box ? (box.minX + box.maxX) / 2 : 0
  const cy = box ? (box.minY + box.maxY) / 2 : 0
  // North up: larger y is drawn higher.
  const project: Project = ([x, y]) => [WIDTH / 2 + (x - cx) * scale, HEIGHT / 2 - (y - cy) * scale]
  return (
    <details className="mt-4 rounded border border-line p-3">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{t.title}</summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-ink-sub">{t.hint}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${id}-column`} label={t.column}>
            <Select id={`${id}-column`} value={column.name} onChange={(e) => setChosen(e.target.value)}>
              {spatial.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-label`} label={t.label}>
            <Select id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)}>
              <option value="">{t.noLabel}</option>
              {names
                .filter((n) => !spatial.some((c) => c.name === n))
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-ink-sub" aria-live="polite">
          {t.summary(drawn.length, unreadable)}
        </p>
        {drawn.length > 0 ? (
          <svg
            width={WIDTH}
            height={HEIGHT}
            role="img"
            aria-label={t.caption(column.name, drawn.length)}
            className="max-w-full rounded border border-line bg-surface-sub"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          >
            {drawn.map((d) => (
              <g key={d.row} data-row={d.row}>
                {d.label ? <title>{d.label}</title> : null}
                <ShapePath shape={d.shape} project={project} scale={scale} />
              </g>
            ))}
          </svg>
        ) : null}
      </div>
    </details>
  )
}
