import { useQuery } from '@tanstack/react-query'
import type { BrowseOptions, Cell } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { cellUrl } from '@/lib/cell-url.ts'
import { downloadBlob, downloadText, safeFilename } from '@/lib/download.ts'
import { rowsQuery, sessionQuery, structureQuery, type TableRef } from '@/lib/queries.ts'
import { svgToPng } from '@/lib/svg-png.ts'
import { bounds, isCutCell, parseShape, parseWholeValue, type Shape, spatialEncoding } from './geometry.ts'
import { outlierIndexes } from './gis-fit.ts'
import { gisDocument, type Project } from './gis-svg.ts'
import { rowKeyFor } from './row-key.ts'

const t = locale.gis
const WIDTH = 640
const HEIGHT = 400
const PAD = 16
const ZOOM_MIN = 0.5
const ZOOM_MAX = 400
const LOAD_PARALLEL = 3
/** The column most likely to name a row: what a hover should say without the user having to pick it. */
const LABEL_GUESS = /^(name|title|label|.*_name|.*name)$/i

interface View {
  zoom: number
  /** Shift of the picture, in the drawing's own pixels. */
  panX: number
  panY: number
}
const HOME: View = { zoom: 1, panX: 0, panY: 0 }

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
 * leaves the browser. Hovering a shape shows the label column's value; the picture zooms and pans; a shape far
 * larger than the rest (a rectangle of the whole world) is kept out of the frame unless asked for; a value the page
 * holds only the start of is loaded whole on request.
 */
export function GisView({ tableRef, options }: { tableRef: TableRef; options: BrowseOptions }) {
  const id = useId()
  const dialect = useQuery(sessionQuery).data?.dialect
  const structure = useQuery(structureQuery(tableRef))
  const rows = useQuery(rowsQuery(tableRef, options))
  const [chosen, setChosen] = useState('')
  const [label, setLabel] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [includeLarge, setIncludeLarge] = useState(false)
  const [view, setView] = useState<View>(HOME)
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  /** Whole values fetched on request, by column and row key; null marks one that could not be read. */
  const [whole, setWhole] = useState<Map<string, Shape | null>>(new Map())
  const [loading, setLoading] = useState<{ done: number; of: number } | null>(null)

  // Zoom about the pointer with the wheel: the page must not scroll under it, so the listener cannot be passive.
  useEffect(() => {
    if (!svgEl) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const box = svgEl.getBoundingClientRect()
      const q = {
        x: ((e.clientX - box.left) / box.width) * WIDTH - WIDTH / 2,
        y: ((e.clientY - box.top) / box.height) * HEIGHT - HEIGHT / 2,
      }
      const f = Math.exp(-e.deltaY * 0.002)
      setView((v) => zoomAbout(v, f, q))
    }
    svgEl.addEventListener('wheel', onWheel, { passive: false })
    return () => svgEl.removeEventListener('wheel', onWheel)
  }, [svgEl])

  const spatial = (structure.data?.columns ?? []).flatMap((c) => {
    const encoding = dialect ? spatialEncoding(dialect, c.dataType) : null
    return encoding ? [{ name: c.name, encoding }] : []
  })
  const column = spatial.find((c) => c.name === chosen) ?? spatial[0]
  const result = rows.data
  const loadWhole = useCallback(
    async (todo: { key: string; url: string }[], encoding: (typeof spatial)[number]['encoding']) => {
      setLoading({ done: 0, of: todo.length })
      const next = new Map<string, Shape | null>()
      let done = 0
      const queue = [...todo]
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          try {
            const res = await fetch(item.url, { credentials: 'same-origin' })
            if (!res.ok) throw new Error(String(res.status))
            const value = encoding === 'mysql-wkb' ? new Uint8Array(await res.arrayBuffer()) : await res.text()
            next.set(item.key, parseWholeValue(encoding, value))
          } catch {
            next.set(item.key, null)
          }
          done++
          setLoading({ done, of: todo.length })
        }
      }
      await Promise.all(Array.from({ length: Math.min(LOAD_PARALLEL, todo.length) }, worker))
      setWhole((cur) => new Map([...cur, ...next]))
      setLoading(null)
    },
    []
  )
  if (spatial.length === 0 || !result || !column) return null

  const names = result.columns.map((c) => c.name)
  const at = names.indexOf(column.name)
  const guess = names.find((n) => !spatial.some((c) => c.name === n) && LABEL_GUESS.test(n)) ?? ''
  const labelName = label ?? guess
  const labelAt = names.indexOf(labelName)
  const all: { shape: Shape; label: string; row: number }[] = []
  const cut: { key: string; url: string }[] = []
  let unreadable = 0
  let unloadable = 0
  result.rows.forEach((row, i) => {
    const cell = row[at] ?? null
    if (cell === null) return
    const rowLabel = labelAt === -1 ? '' : labelOf(row[labelAt])
    const shape = parseShape(column.encoding, cell)
    if (shape) return void all.push({ shape, label: rowLabel, row: i })
    if (!isCutCell(cell)) return void unreadable++
    const key = rowKeyFor(result, row)
    if (!key) return void unreadable++
    const id = `${column.name}|${JSON.stringify(key)}`
    if (!whole.has(id)) return void cut.push({ key: id, url: cellUrl({ ...tableRef, key, column: column.name }) })
    const fetched = whole.get(id)
    if (fetched) all.push({ shape: fetched, label: rowLabel, row: i })
    else unloadable++
  })
  const large = new Set(outlierIndexes(all.map((d) => d.shape)))
  const drawn = includeLarge ? all : all.filter((_, i) => !large.has(i))
  const box = bounds(drawn.map((d) => d.shape))
  // One scale for both axes, so a square stays square; a single point gets a unit box around it.
  const spanX = box ? Math.max(box.maxX - box.minX, 1e-9) : 1
  const spanY = box ? Math.max(box.maxY - box.minY, 1e-9) : 1
  const fit =
    box && (spanX > 1e-9 || spanY > 1e-9) ? Math.min((WIDTH - 2 * PAD) / spanX, (HEIGHT - 2 * PAD) / spanY) : 1
  const scale = fit * view.zoom
  const cx = box ? (box.minX + box.maxX) / 2 : 0
  const cy = box ? (box.minY + box.maxY) / 2 : 0
  // North up: larger y is drawn higher.
  const project: Project = ([x, y]) => [
    WIDTH / 2 + (x - cx) * scale + view.panX,
    HEIGHT / 2 - (y - cy) * scale + view.panY,
  ]
  const file = safeFilename(`${tableRef.table}_${column.name}`, 'svg')
  const svgFile = () => gisDocument(drawn, project, scale, WIDTH, HEIGHT)
  const savePng = () =>
    svgToPng(svgFile(), WIDTH, HEIGHT).then(
      (blob) => {
        setFailed(false)
        downloadBlob(file.replace(/\.svg$/, '.png'), blob)
      },
      () => setFailed(true)
    )
  const zoomBy = (f: number) => setView((v) => zoomAbout(v, f, { x: 0, y: 0 }))
  return (
    <details className="mt-4 rounded border border-line p-3">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{t.title}</summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-ink-sub">{t.hint}</p>
        <div className="flex flex-wrap items-start gap-2">
          <Field id={`${id}-column`} label={t.column}>
            <Select
              id={`${id}-column`}
              value={column.name}
              onChange={(e) => {
                setChosen(e.target.value)
                setView(HOME)
              }}
            >
              {spatial.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-label`} label={t.label}>
            <Select id={`${id}-label`} value={labelName} onChange={(e) => setLabel(e.target.value)}>
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
          {t.summary(drawn.length, unreadable + unloadable)}
        </p>
        {large.size > 0 ? (
          <label className="flex items-center gap-2 text-xs text-ink-sub">
            <input
              type="checkbox"
              checked={includeLarge}
              onChange={(e) => {
                setIncludeLarge(e.target.checked)
                setView(HOME)
              }}
            />
            {t.includeLarge(large.size)}
          </label>
        ) : null}
        {cut.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-sub">
            <span>{t.cut(cut.length)}</span>
            <Button size="sm" disabled={loading !== null} onClick={() => void loadWhole(cut, column.encoding)}>
              {loading ? t.loading(loading.done, loading.of) : t.loadCut(cut.length)}
            </Button>
          </div>
        ) : null}
        {unloadable > 0 ? <p className="text-xs text-ink-sub">{t.unloadable(unloadable)}</p> : null}
        {drawn.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => zoomBy(2)} aria-label={t.zoomIn}>
              ＋
            </Button>
            <Button size="sm" onClick={() => zoomBy(0.5)} aria-label={t.zoomOut}>
              －
            </Button>
            <Button size="sm" onClick={() => setView(HOME)}>
              {t.zoomReset}
            </Button>
            <Button size="sm" onClick={() => downloadText(file, svgFile(), 'image/svg+xml')}>
              {t.saveSvg}
            </Button>
            <Button size="sm" onClick={() => void savePng()}>
              {t.savePng}
            </Button>
            {failed ? (
              <span role="alert" className="text-xs text-red-800 dark:text-red-200">
                {t.saveFailed}
              </span>
            ) : null}
          </div>
        ) : null}
        {drawn.length > 0 ? (
          <svg
            ref={setSvgEl}
            width={WIDTH}
            height={HEIGHT}
            role="img"
            aria-label={t.caption(column.name, drawn.length)}
            className={`max-w-full touch-none rounded border border-line bg-surface-sub ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              setDrag({ x: e.clientX, y: e.clientY })
            }}
            onPointerMove={(e) => {
              if (!drag) return
              const ratio = WIDTH / e.currentTarget.getBoundingClientRect().width
              const dx = (e.clientX - drag.x) * ratio
              const dy = (e.clientY - drag.y) * ratio
              setDrag({ x: e.clientX, y: e.clientY })
              setView((v) => ({ ...v, panX: v.panX + dx, panY: v.panY + dy }))
            }}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
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

/** The view after zooming by `f` with the point `q` (relative to the picture's centre) staying where it is. */
function zoomAbout(v: View, f: number, q: { x: number; y: number }): View {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * f))
  const k = zoom / v.zoom
  return { zoom, panX: q.x - (q.x - v.panX) * k, panY: q.y - (q.y - v.panY) * k }
}
