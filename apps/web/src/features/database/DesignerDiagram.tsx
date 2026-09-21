import type { DesignerView, RelationDef } from '@tsmyadmin/shared'
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { locale } from '@/config/locale.ts'
import {
  BOX_WIDTH,
  boxHeight,
  DEFAULT_VIEW,
  fitText,
  HEADER_HEIGHT,
  type Point,
  ROW_HEIGHT,
  relationLabel,
  relationPath,
  relationRoute,
  routeMiddle,
  snapToGrid,
  textRoom,
} from './designer-layout.ts'

const t = locale.designer
const STEP = 10
const BIG_STEP = 50
const PAD = 40
/** Pointer travel below this is a click with an unsteady hand, not a drag. */
const DRAG_THRESHOLD = 4

/** Distinct per key: constraint names are unique within a table, not across the database. */
export const relationKey = (r: RelationDef) => JSON.stringify([r.table, r.name])

/**
 * Tables as boxes and foreign keys as lines. Boxes move by dragging or, once focused, with the arrow keys (Shift
 * for larger steps); `commit` is true for the move that ends one, which is when the page saves the layout.
 */
export function DesignerDiagram({
  tables,
  relations,
  columns,
  display,
  positions,
  onMove,
  relate,
  view = DEFAULT_VIEW,
}: {
  tables: readonly string[]
  relations: readonly RelationDef[]
  /** What each box lists. */
  columns: ReadonlyMap<string, readonly string[]>
  /** The column marked as each table's display column. */
  display: ReadonlyMap<string, string>
  positions: Readonly<Record<string, Point>>
  onMove: (table: string, to: Point, commit: boolean) => void
  /** While set, the columns are the buttons (pick one, then the one it refers to) and boxes stay where they are. */
  relate?: { from: { table: string; column: string } | null; onPick: (table: string, column: string) => void }
  view?: DesignerView
}) {
  /** Where in the box it was grabbed, and where it was last put. */
  const drag = useRef<{ table: string; dx: number; dy: number; start: Point; last: Point; moved: boolean } | null>(null)
  /** The box last focused or picked: its names are shown whole below the diagram (the boxes cut what does not fit). */
  const [selected, setSelected] = useState<string | null>(null)
  const at = (table: string): Point => positions[table] ?? { x: 0, y: 0 }
  const listed = (table: string) => (view.compact ? [] : (columns.get(table) ?? []))
  const fullLabel = (table: string, c: string) => (display.get(table) === c ? `◆ ${c}` : c)
  const cutAny = tables.some(
    (name) =>
      fitText(name, 12, textRoom(8), true) !== name ||
      listed(name).some((c) => fitText(fullLabel(name, c), 12, textRoom(8)) !== fullLabel(name, c))
  )
  const width = Math.max(...tables.map((name) => at(name).x + BOX_WIDTH)) + PAD
  const height = Math.max(...tables.map((name) => at(name).y + boxHeight(listed(name).length, view.compact))) + PAD
  // Dragged boxes land on the grid when snapping is on; the arrow keys already move by whole steps.
  const clamp = (p: Point): Point => {
    const kept = { x: Math.max(0, p.x), y: Math.max(0, p.y) }
    return view.snap ? snapToGrid(kept) : kept
  }

  // In diagram coordinates, measured against the SVG each time, so scrolling the diagram mid-drag does not jump the box.
  const pointerAt = (e: PointerEvent<SVGGElement>): Point => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }
  const startDrag = (table: string) => (e: PointerEvent<SVGGElement>) => {
    // Safari does not focus an SVG group on a click, so the pick is taken here as well as on focus.
    setSelected(table)
    const p = at(table)
    const pointer = pointerAt(e)
    drag.current = { table, dx: pointer.x - p.x, dy: pointer.y - p.y, start: pointer, last: p, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current
    if (!d) return
    const pointer = pointerAt(e)
    if (!d.moved && Math.hypot(pointer.x - d.start.x, pointer.y - d.start.y) < DRAG_THRESHOLD) return
    d.last = clamp({ x: pointer.x - d.dx, y: pointer.y - d.dy })
    d.moved = true
    onMove(d.table, d.last, false)
  }
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    // A click only focuses the box: saving its position would take it out of the automatic layout.
    if (d.moved) onMove(d.table, d.last, true)
  }
  const nudge = (table: string) => (e: KeyboardEvent<SVGGElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP
    const delta: Partial<Record<string, Point>> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    const p = at(table)
    onMove(table, clamp({ x: p.x + d.x, y: p.y + d.y }), true)
  }

  const shown = selected !== null && tables.includes(selected) ? selected : null
  return (
    <>
      <figure className="max-h-[70vh] overflow-auto rounded border border-line bg-surface-sub">
        <figcaption className="sr-only">{t.diagram}</figcaption>
        <svg width={width} height={height} className="select-none">
          {(view.showLines ? relations : []).map((r) => {
            const mid = view.lineLabels ? routeMiddle(relationRoute(r, at, listed, view.lineStyle, view.compact)) : null
            return (
              <g key={relationKey(r)} aria-hidden>
                <path
                  d={relationPath(r, at, listed, view.lineStyle, view.compact)}
                  className="fill-none stroke-brand"
                  strokeWidth={1.5}
                />
                {mid ? (
                  <text x={mid.x} y={mid.y - 4} textAnchor="middle" className="fill-brand text-[10px]">
                    {relationLabel(r)}
                  </text>
                ) : null}
              </g>
            )
          })}
          {tables.map((name) => {
            const p = at(name)
            const cols = listed(name)
            const contents = (
              <>
                <rect
                  width={BOX_WIDTH}
                  height={boxHeight(cols.length, view.compact)}
                  rx={4}
                  className="fill-surface stroke-line-strong group-focus-visible:stroke-brand"
                  strokeWidth={1.5}
                />
                <text x={8} y={18} className="fill-ink text-xs font-semibold">
                  {fitText(name, 12, textRoom(8), true)}
                  {/* The whole name, when it was cut: shown as a tooltip. */}
                  {fitText(name, 12, textRoom(8), true) === name ? null : <title>{name}</title>}
                </text>
                <line x1={0} x2={BOX_WIDTH} y1={HEADER_HEIGHT} y2={HEADER_HEIGHT} className="stroke-line" />
              </>
            )
            const label = (c: string) => (display.get(name) === c ? `◆ ${c}` : c)
            if (relate) {
              return (
                <g key={name} transform={`translate(${p.x} ${p.y})`}>
                  {contents}
                  {cols.map((c, i) => {
                    const picked = relate.from?.table === name && relate.from.column === c
                    const y = HEADER_HEIGHT + i * ROW_HEIGHT
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>.
                      <g
                        key={c}
                        role="button"
                        tabIndex={0}
                        aria-label={t.columnLabel(name, c)}
                        aria-pressed={picked}
                        className="group cursor-pointer outline-none"
                        onFocus={() => setSelected(name)}
                        onClick={() => relate.onPick(name, c)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          relate.onPick(name, c)
                        }}
                      >
                        <rect
                          x={1}
                          y={y}
                          width={BOX_WIDTH - 2}
                          height={ROW_HEIGHT}
                          className={`${picked ? 'fill-row-hover stroke-brand' : 'fill-transparent'} group-hover:fill-row-hover group-focus-visible:stroke-brand`}
                        />
                        <text x={8} y={y + 14} className="fill-ink-sub text-xs">
                          {fitText(label(c), 12, textRoom(8))}
                          {fitText(label(c), 12, textRoom(8)) === label(c) ? null : <title>{label(c)}</title>}
                        </text>
                      </g>
                    )
                  })}
                </g>
              )
            }
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>.
              <g
                key={name}
                role="button"
                tabIndex={0}
                aria-label={t.boxLabel(name)}
                transform={`translate(${p.x} ${p.y})`}
                // touch-none: on a touch screen the gesture moves the box instead of scrolling the diagram.
                className="group cursor-move touch-none outline-none"
                onFocus={() => setSelected(name)}
                onPointerDown={startDrag(name)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={nudge(name)}
              >
                {contents}
                {cols.map((c, i) => (
                  <text key={c} x={8} y={HEADER_HEIGHT + i * ROW_HEIGHT + 14} className="fill-ink-sub text-xs">
                    {fitText(label(c), 12, textRoom(8))}
                    {fitText(label(c), 12, textRoom(8)) === label(c) ? null : <title>{label(c)}</title>}
                  </text>
                ))}
              </g>
            )
          })}
        </svg>
      </figure>
      {shown !== null ? (
        // Where a name the box had to cut is read whole (and copied): a tooltip is out of reach on a touch screen and
        // from the keyboard.
        <output aria-live="polite" className="mt-2 block rounded border border-line bg-surface p-2 text-sm">
          <span className="sr-only">{t.selectedBox}: </span>
          <span className="select-text break-all font-semibold text-ink">{shown}</span>
          {listed(shown).length > 0 ? (
            <ul className="mt-1 select-text space-y-0.5 break-all font-mono text-xs text-ink-sub">
              {listed(shown).map((c) => (
                <li key={c}>{fullLabel(shown, c)}</li>
              ))}
            </ul>
          ) : null}
        </output>
      ) : cutAny ? (
        <p className="mt-2 text-xs text-ink-sub">{t.cutHint}</p>
      ) : null}
    </>
  )
}
